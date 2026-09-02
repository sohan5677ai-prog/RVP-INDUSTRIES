import { useState, useMemo, Fragment } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, getErrorMessage } from '@/lib/api';
import type { Purchase, SaleOrder, Payment, CompanyProfile, SaleStatus, HuskTransfer, ShellTransfer, StockTransfer, LorryConfirmation } from '@/lib/types';
import { rupees, shortDate } from '@/lib/format';
import { calcHamali, calcKataFee, companyVehicleNumbers, pappuLoadingHamali, qualityAdjustmentFreight } from '@/lib/calc';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loader2, ArrowDownToLine, ArrowUpFromLine, Truck, ArrowLeftRight, MessageCircle, ChevronRight, IndianRupee } from 'lucide-react';
import { PaginationBar } from '@/components/ui/pagination-bar';
import { SearchInput } from '@/components/ui/search-input';
import { usePagedRows } from '@/lib/usePagedRows';
import { ExportButtons } from '@/components/ExportButtons';
import { PageHeader } from '@/components/PageHeader';
import { ExpandPanel, PanelLabel, PanelStack, PanelCard, PanelTitle, Figure, PanelEmpty } from '@/components/ExpandPanel';
import { cn } from '@/lib/utils';
import type { ExportColumn } from '@/lib/export';
import SuryaRoadTransport from '@/pages/SuryaRoadTransport';
import LorryConfirmations from '@/pages/LorryConfirmations';

type PurchaseRow = Purchase & {
  stockIn?: {
    arrivalDate?: string;
    lorryNumber?: string | null;
    invoiceNumber?: string | null;
    loadingLocation?: string | null;
    freightTonnageKg?: number | null;
    purchaseOrder?: { party?: { name?: string | null } | null } | null;
  };
};

/**
 * Inward freight owed on a purchase: the freight fixed at recording (BASE-priced
 * POs) plus any FREIGHT quality adjustment taken off the party's bill at
 * approval - that one is recovered from the supplier but still owed to the lorry.
 */
function inwardFreightOf(p: PurchaseRow): number {
  const rawFreight = Number(p.freightCharge ?? 0);
  const basis = Number((p as any).freightTonnageKg ?? p.stockIn?.freightTonnageKg ?? 0);
  const net = Number(p.netWeightKg ?? 0);
  const baseFreight = basis > 0 && net > 0 ? (rawFreight * net) / basis : rawFreight;
  return baseFreight + qualityAdjustmentFreight(p.verification?.qualityAdjustments);
}

type PaymentStatus = 'Paid' | 'Partial' | 'Pending';

interface FreightRow {
  id: string;
  date: string;
  lorry: string | null;
  invoice: string | null;
  freight: number;
  hamali: number;
  kata: number;
  transport: number;
  net: number;
  deliveryStatus: string;
  sourced: 'Purchase' | 'Sale' | 'Transfer';
  destination: string | null;
  party: string | null;
  kind?: 'Husk' | 'Seed' | 'Dust';
  weightKg?: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function combineSharedLorryRows(rows: FreightRow[]): FreightRow[] {
  const groups = new Map<string, FreightRow[]>();
  for (const r of rows) {
    if (!r.lorry) {
      const key = `nolorry-${r.id}`;
      groups.set(key, [r]);
      continue;
    }
    const dateKey = r.date ? r.date.slice(0, 10) : '';
    const key = `${r.lorry.toUpperCase()}_${dateKey}`;
    const list = groups.get(key) || [];
    list.push(r);
    groups.set(key, list);
  }

  const result: FreightRow[] = [];
  for (const list of groups.values()) {
    if (list.length === 1) {
      result.push(list[0]);
      continue;
    }
    const invoices = Array.from(new Set(list.map((x) => x.invoice).filter(Boolean))).join(', ');
    const parties = Array.from(new Set(list.map((x) => x.party).filter(Boolean))).join(', ');
    const destinations = Array.from(new Set(list.map((x) => x.destination).filter(Boolean))).join(', ');
    const sourcedSet = new Set(list.map((x) => x.sourced));
    const sourced = (sourcedSet.size === 1 ? list[0].sourced : 'Purchase / Sale') as FreightRow['sourced'];
    const kind = Array.from(new Set(list.map((x) => x.kind).filter(Boolean))).join(', ') as any;

    const totalFreight = round2(list.reduce((s, x) => s + x.freight, 0));
    const totalHamali = round2(list.reduce((s, x) => s + x.hamali, 0));
    const totalKata = round2(list.reduce((s, x) => s + x.kata, 0));
    const totalTransport = round2(list.reduce((s, x) => s + x.transport, 0));
    const totalNet = round2(list.reduce((s, x) => s + x.net, 0));
    const totalWeight = list.reduce((s, x) => s + (x.weightKg ?? 0), 0);

    const isReceived = list.some((x) => x.deliveryStatus === 'RECEIVED' || x.deliveryStatus === 'DELIVERED');

    result.push({
      id: `comb-${list[0].lorry}-${list[0].date.slice(0, 10)}`,
      date: list[0].date,
      lorry: list[0].lorry,
      invoice: invoices || null,
      freight: totalFreight,
      hamali: totalHamali,
      kata: totalKata,
      transport: totalTransport,
      net: totalNet,
      deliveryStatus: isReceived ? 'RECEIVED' : list[0].deliveryStatus,
      sourced,
      destination: destinations || null,
      party: parties || null,
      kind: kind || undefined,
      weightKg: totalWeight || undefined,
    });
  }

  return result;
}

const deliveryVariant: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  PENDING: 'secondary',
  DISPATCHED: 'default',
  REACHED: 'outline',
  DELIVERED: 'destructive',
  RECEIVED: 'destructive',
};

function titleCase(s: string) {
  return s.charAt(0) + s.slice(1).toLowerCase();
}

type PayFilterValue = 'all' | 'unpaid' | 'paid';

/** Narrow rows to a paid/unpaid subset using the shared per-lorry status. */
function filterByPayment(
  rows: FreightRow[],
  filter: PayFilterValue,
  statusFor: (row: FreightRow) => PaymentStatus,
): FreightRow[] {
  if (filter === 'all') return rows;
  return rows.filter((r) => {
    const paid = statusFor(r) === 'Paid';
    return filter === 'paid' ? paid : !paid; // "unpaid" = Pending or Partial
  });
}

/** Small segmented All / Unpaid / Paid toggle shown above each freight table. */
function PayFilter({ value, onChange }: { value: PayFilterValue; onChange: (v: PayFilterValue) => void }) {
  const opts: { key: PayFilterValue; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'unpaid', label: 'Unpaid' },
    { key: 'paid', label: 'Paid' },
  ];
  return (
    <div className="inline-flex rounded-md border bg-background p-0.5">
      {opts.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
            value === o.key
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function FreightTable({
  freightLabel,
  exportName,
  rows,
  paymentStatusFor,
  dueFor,
  onPay,
  hideDeductions = false,
  paymentsByLorry,
}: {
  freightLabel: string;
  exportName: string;
  rows: FreightRow[];
  paymentStatusFor: (row: FreightRow) => PaymentStatus;
  dueFor: (row: FreightRow) => number;
  onPay: (row: FreightRow, due: number) => void;
  hideDeductions?: boolean;
  paymentsByLorry: Map<string, { date: string, amount: number, reference: string | null }[]>;
}) {
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [payFilter, setPayFilter] = useState<PayFilterValue>('all');
  const [search, setSearch] = useState('');

  const filteredRows = useMemo(() => {
    const payFiltered = filterByPayment(rows, payFilter, paymentStatusFor);
    const q = search.trim().toLowerCase();
    if (!q) return payFiltered;
    const qNorm = q.replace(/[^a-z0-9]/g, '');
    return payFiltered.filter((r) => {
      const matchLorry = (r.lorry ?? '').toLowerCase().includes(q) || (qNorm !== '' && (r.lorry ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(qNorm));
      const matchInvoice = (r.invoice ?? '').toLowerCase().includes(q) || (qNorm !== '' && (r.invoice ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(qNorm));
      const matchParty = (r.party ?? '').toLowerCase().includes(q);
      const matchDest = (r.destination ?? '').toLowerCase().includes(q);
      const matchStatus = r.deliveryStatus.toLowerCase().includes(q);
      const matchPayment = paymentStatusFor(r).toLowerCase().includes(q);
      const matchSourced = r.sourced.toLowerCase().includes(q);
      return matchLorry || matchInvoice || matchParty || matchDest || matchStatus || matchPayment || matchSourced;
    });
  }, [rows, payFilter, paymentStatusFor, search]);

  const { page, setPage, pageSize, setPageSize, totalPages, total, pageRows } = usePagedRows(filteredRows, 50);

  const t = {
    freight: filteredRows.reduce((s, r) => s + r.freight, 0),
    hamali: filteredRows.reduce((s, r) => s + r.hamali, 0),
    kata: filteredRows.reduce((s, r) => s + r.kata, 0),
    transport: filteredRows.reduce((s, r) => s + r.transport, 0),
    net: filteredRows.reduce((s, r) => s + r.net, 0),
    due: filteredRows.reduce((s, r) => s + dueFor(r), 0),
  };

  const exportColumns: ExportColumn<FreightRow>[] = [
    { header: 'Date', value: (r) => shortDate(r.date) },
    { header: 'Lorry No', value: (r) => r.lorry ?? '' },
    { header: 'Invoice No', value: (r) => r.invoice ?? '' },
    ...(hideDeductions ? [
      { header: 'Sourced', value: (r: FreightRow) => r.sourced },
      { header: 'Destination', value: (r: FreightRow) => r.destination ?? '' },
      { header: 'Party', value: (r: FreightRow) => r.party ?? '' },
    ] : []),
    { header: freightLabel, value: (r) => rupees(r.freight), excel: (r) => r.freight, numFmt: '#,##0.00', align: 'right' },
    ...(hideDeductions ? [] : [
      { header: 'Hamali', value: (r: FreightRow) => (r.hamali ? rupees(r.hamali) : ''), excel: (r: FreightRow) => r.hamali || null, numFmt: '#,##0.00', align: 'right' as const },
      { header: 'Kata', value: (r: FreightRow) => (r.kata ? rupees(r.kata) : ''), excel: (r: FreightRow) => r.kata || null, numFmt: '#,##0.00', align: 'right' as const },
      { header: 'Transport', value: (r: FreightRow) => (r.transport ? rupees(r.transport) : ''), excel: (r: FreightRow) => r.transport || null, numFmt: '#,##0.00', align: 'right' as const },
    ]),
    { header: 'Net Freight', value: (r) => rupees(r.net), excel: (r) => r.net, numFmt: '#,##0.00', align: 'right' },
    { header: 'Due', value: (r) => rupees(dueFor(r)), excel: (r) => dueFor(r), numFmt: '#,##0.00', align: 'right' },
    { header: 'Delivery Status', value: (r) => titleCase(r.deliveryStatus) },
    { header: 'Payment Status', value: (r) => paymentStatusFor(r) },
  ];

  return (
    <div className="rounded-lg border bg-card overflow-x-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 border-b">
        <div className="flex flex-wrap items-center gap-3">
          <PayFilter value={payFilter} onChange={setPayFilter} />
          <SearchInput
            value={search}
            onValueChange={setSearch}
            placeholder="Search lorry no, invoice, party, destination…"
            containerClassName="w-full sm:w-72"
            className="h-8 text-xs"
          />
        </div>
        <ExportButtons filename={exportName} title={`${freightLabel} Dues`} subtitle={`${filteredRows.length} record(s)`} columns={exportColumns} rows={filteredRows} />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Lorry No</TableHead>
            <TableHead>Invoice No</TableHead>
            {hideDeductions && <TableHead>Sourced</TableHead>}
            {hideDeductions && <TableHead>Destination</TableHead>}
            {hideDeductions && <TableHead>Party</TableHead>}
            <TableHead className="text-right">{freightLabel}</TableHead>
            {!hideDeductions && <TableHead className="text-right">Hamali</TableHead>}
            {!hideDeductions && <TableHead className="text-right">Kata</TableHead>}
            {!hideDeductions && <TableHead className="text-right">Transport</TableHead>}
            <TableHead className="text-right">Net Freight</TableHead>
            <TableHead className="text-right">Due</TableHead>
            <TableHead>Delivery Status</TableHead>
            <TableHead>Payment Status</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredRows.length === 0 && (
            <TableRow><TableCell colSpan={hideDeductions ? 10 : 12} className="text-center text-muted-foreground py-8">No records.</TableCell></TableRow>
          )}
          {(pageRows ?? []).map((r) => {
            const pay = paymentStatusFor(r);
            const due = dueFor(r);
            const isExpanded = expandedRow === r.lorry;
            return (
              <Fragment key={r.id}>
                <TableRow
                  className={cn('transition-colors', r.lorry ? cn('cursor-pointer', isExpanded ? 'bg-accent/40' : 'hover:bg-accent/30') : 'hover:bg-muted/50')}
                  onClick={() => r.lorry && setExpandedRow(isExpanded ? null : r.lorry)}
                >
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {r.lorry && <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200', isExpanded && 'rotate-90 text-primary')} />}
                      {shortDate(r.date)}
                    </div>
                  </TableCell>
                  <TableCell className="font-sans text-xs font-medium text-foreground/80">{r.lorry ?? '-'}</TableCell>
                  <TableCell className="font-sans text-xs font-medium text-muted-foreground">{r.invoice ?? '-'}</TableCell>
                  {hideDeductions && <TableCell>{r.sourced}</TableCell>}
                  {hideDeductions && <TableCell>{r.destination ?? '-'}</TableCell>}
                  {hideDeductions && <TableCell>{r.party ?? '-'}</TableCell>}
                  <TableCell className="text-right font-medium">{rupees(r.freight)}</TableCell>
                  {!hideDeductions && <TableCell className="text-right text-amber-600 dark:text-amber-400">{r.hamali ? `−${rupees(r.hamali)}` : '-'}</TableCell>}
                  {!hideDeductions && <TableCell className="text-right text-amber-600 dark:text-amber-400">{r.kata ? `−${rupees(r.kata)}` : '-'}</TableCell>}
                  {!hideDeductions && <TableCell className="text-right text-amber-600 dark:text-amber-400">{r.transport ? `−${rupees(r.transport)}` : '-'}</TableCell>}
                  <TableCell className="text-right font-medium">{rupees(r.net)}</TableCell>
                  <TableCell className={cn('text-right font-mono tabular-nums', due === 0 ? 'text-emerald-600 dark:text-emerald-400 font-medium' : 'text-rose-600 dark:text-rose-400 font-bold')}>
                    {rupees(due)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={deliveryVariant[r.deliveryStatus] ?? 'secondary'}>{titleCase(r.deliveryStatus)}</Badge>
                  </TableCell>
                  <TableCell>
                    <span
                      className={`text-xs font-semibold ${
                        pay === 'Paid'
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : pay === 'Partial'
                            ? 'text-amber-600 dark:text-amber-400'
                            : 'text-rose-600 dark:text-rose-400'
                      }`}
                    >
                      {pay}
                    </span>
                  </TableCell>
                  <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                    {r.lorry && pay !== 'Paid' ? (
                      <Button size="sm" variant="outline" onClick={() => onPay(r, due)}>
                        Pay
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
                {isExpanded && r.lorry && (() => {
                  const history = paymentsByLorry.get(r.lorry!) ?? [];
                  return (
                    <ExpandPanel colSpan={hideDeductions ? 10 : 12}>
                      <PanelLabel>Payment History for {r.lorry} · {history.length}</PanelLabel>
                      {history.length === 0 ? (
                        <PanelEmpty>No payments recorded.</PanelEmpty>
                      ) : (
                        <PanelStack>
                          {history.map((pay, i) => (
                            <PanelCard
                              key={i}
                              icon={IndianRupee}
                              identity={
                                <PanelTitle>
                                  <span className="font-mono text-sm font-semibold">{shortDate(pay.date)}</span>
                                  {pay.reference && <span className="text-xs text-muted-foreground">{pay.reference}</span>}
                                </PanelTitle>
                              }
                              figures={<Figure label="Amount" value={rupees(pay.amount)} valueClass="text-emerald-600 dark:text-emerald-400" />}
                            />
                          ))}
                        </PanelStack>
                      )}
                    </ExpandPanel>
                  );
                })()}
              </Fragment>
            );
          })}
        </TableBody>
        {filteredRows.length > 0 && (
          <tfoot>
            <TableRow className="border-t-2 font-bold bg-muted/30">
              <TableCell colSpan={hideDeductions ? 6 : 3}>Total</TableCell>
              <TableCell className="text-right">{rupees(t.freight)}</TableCell>
              {!hideDeductions && <TableCell className="text-right text-amber-600 dark:text-amber-400">−{rupees(t.hamali)}</TableCell>}
              {!hideDeductions && <TableCell className="text-right text-amber-600 dark:text-amber-400">−{rupees(t.kata)}</TableCell>}
              {!hideDeductions && <TableCell className="text-right text-amber-600 dark:text-amber-400">−{rupees(t.transport)}</TableCell>}
              <TableCell className="text-right">{rupees(t.net)}</TableCell>
              <TableCell className="text-right font-bold">{rupees(t.due)}</TableCell>
              <TableCell colSpan={3} />
            </TableRow>
          </tfoot>
        )}
      </Table>
      <PaginationBar page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalPages={totalPages} total={total} />
    </div>
  );
}

const kindVariant: Record<string, 'default' | 'secondary' | 'outline'> = {
  Husk: 'secondary',
  Seed: 'default',
  Dust: 'outline',
};

/**
 * Transfer transport payable to KNM Transport (husk / seed / pre-cleaner dust).
 * Billed to KNM Transport per trip / weight and settled per lorry.
 */
function TransfersTable({
  rows,
  paymentStatusFor,
  dueFor,
  onPay,
  paymentsByLorry,
}: {
  rows: FreightRow[];
  paymentStatusFor: (row: FreightRow) => PaymentStatus;
  dueFor: (row: FreightRow) => number;
  onPay: (row: FreightRow, due: number) => void;
  paymentsByLorry: Map<string, { date: string; amount: number; reference: string | null }[]>;
}) {
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [payFilter, setPayFilter] = useState<PayFilterValue>('all');
  const [search, setSearch] = useState('');

  const filteredRows = useMemo(() => {
    const payFiltered = filterByPayment(rows, payFilter, paymentStatusFor);
    const q = search.trim().toLowerCase();
    if (!q) return payFiltered;
    const qNorm = q.replace(/[^a-z0-9]/g, '');
    return payFiltered.filter((r) => {
      const matchLorry = (r.lorry ?? '').toLowerCase().includes(q) || (qNorm !== '' && (r.lorry ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(qNorm));
      const matchDest = (r.destination ?? '').toLowerCase().includes(q);
      const matchKind = (r.kind ?? '').toLowerCase().includes(q);
      const matchParty = (r.party ?? '').toLowerCase().includes(q);
      const matchPayment = paymentStatusFor(r).toLowerCase().includes(q);
      return matchLorry || matchDest || matchKind || matchParty || matchPayment;
    });
  }, [rows, payFilter, paymentStatusFor, search]);

  const { page, setPage, pageSize, setPageSize, totalPages, total, pageRows } = usePagedRows(filteredRows, 50);
  const totalTransport = filteredRows.reduce((s, r) => s + r.net, 0);
  const totalDue = filteredRows.reduce((s, r) => s + dueFor(r), 0);

  const exportColumns: ExportColumn<FreightRow>[] = [
    { header: 'Date', value: (r) => shortDate(r.date) },
    { header: 'Type', value: (r) => r.kind ?? '' },
    { header: 'Route', value: (r) => r.destination ?? '' },
    { header: 'Lorry No', value: (r) => r.lorry ?? '' },
    { header: 'Weight (kg)', value: (r) => r.weightKg ?? 0, numFmt: '#,##0', align: 'right' },
    { header: 'Transport', value: (r) => rupees(r.net), excel: (r) => r.net, numFmt: '#,##0.00', align: 'right' },
    { header: 'Due', value: (r) => rupees(dueFor(r)), excel: (r) => dueFor(r), numFmt: '#,##0.00', align: 'right' },
    { header: 'Payment Status', value: (r) => paymentStatusFor(r) },
  ];

  return (
    <div className="rounded-lg border bg-card overflow-x-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 border-b">
        <div className="flex flex-wrap items-center gap-3">
          <PayFilter value={payFilter} onChange={setPayFilter} />
          <SearchInput
            value={search}
            onValueChange={setSearch}
            placeholder="Search lorry no, route, type…"
            containerClassName="w-full sm:w-72"
            className="h-8 text-xs"
          />
        </div>
        <ExportButtons filename="Freight_Dues_KNM_Transfers" title="KNM Transfer Transport" subtitle={`${filteredRows.length} transfer(s)`} columns={exportColumns} rows={filteredRows} />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Route</TableHead>
            <TableHead>Lorry No</TableHead>
            <TableHead className="text-right">Weight</TableHead>
            <TableHead className="text-right">Transport</TableHead>
            <TableHead className="text-right">Due</TableHead>
            <TableHead>Payment Status</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredRows.length === 0 && (
            <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-8">No transfers.</TableCell></TableRow>
          )}
          {(pageRows ?? []).map((r) => {
            const pay = paymentStatusFor(r);
            const due = dueFor(r);
            const isExpanded = expandedRow === r.lorry;
            return (
              <Fragment key={r.id}>
                <TableRow
                  className={cn('transition-colors', r.lorry ? cn('cursor-pointer', isExpanded ? 'bg-accent/40' : 'hover:bg-accent/30') : 'hover:bg-muted/50')}
                  onClick={() => r.lorry && setExpandedRow(isExpanded ? null : r.lorry)}
                >
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {r.lorry && <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200', isExpanded && 'rotate-90 text-primary')} />}
                      {shortDate(r.date)}
                    </div>
                  </TableCell>
                  <TableCell><Badge variant={kindVariant[r.kind ?? ''] ?? 'secondary'}>{r.kind}</Badge></TableCell>
                  <TableCell className="text-sm">{r.destination ?? '-'}</TableCell>
                  <TableCell className="font-sans text-xs font-medium text-foreground/80">{r.lorry ?? '-'}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{r.weightKg != null ? `${(r.weightKg / 1000).toFixed(2)} t` : '-'}</TableCell>
                  <TableCell className="text-right font-medium">{rupees(r.net)}</TableCell>
                  <TableCell className={cn('text-right font-mono tabular-nums', due === 0 ? 'text-emerald-600 dark:text-emerald-400 font-medium' : 'text-rose-600 dark:text-rose-400 font-bold')}>
                    {rupees(due)}
                  </TableCell>
                  <TableCell>
                    {r.lorry ? (
                      <span
                        className={`text-xs font-semibold ${
                          pay === 'Paid'
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : pay === 'Partial'
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-rose-600 dark:text-rose-400'
                        }`}
                      >
                        {pay}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">No lorry</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                    {r.lorry && pay !== 'Paid' ? (
                      <Button size="sm" variant="outline" onClick={() => onPay(r, due)}>
                        Pay
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
                {isExpanded && r.lorry && (() => {
                  const history = paymentsByLorry.get(r.lorry!) ?? [];
                  return (
                    <ExpandPanel colSpan={9}>
                      <PanelLabel>Payment History for {r.lorry} · {history.length}</PanelLabel>
                      {history.length === 0 ? (
                        <PanelEmpty>No payments recorded.</PanelEmpty>
                      ) : (
                        <PanelStack>
                          {history.map((pay, i) => (
                            <PanelCard
                              key={i}
                              icon={IndianRupee}
                              identity={
                                <PanelTitle>
                                  <span className="font-mono text-sm font-semibold">{shortDate(pay.date)}</span>
                                  {pay.reference && <span className="text-xs text-muted-foreground">{pay.reference}</span>}
                                </PanelTitle>
                              }
                              figures={<Figure label="Amount" value={rupees(pay.amount)} valueClass="text-emerald-600 dark:text-emerald-400" />}
                            />
                          ))}
                        </PanelStack>
                      )}
                    </ExpandPanel>
                  );
                })()}
              </Fragment>
            );
          })}
        </TableBody>
        {filteredRows.length > 0 && (
          <tfoot>
            <TableRow className="border-t-2 font-bold bg-muted/30">
              <TableCell colSpan={5}>Total</TableCell>
              <TableCell className="text-right">{rupees(totalTransport)}</TableCell>
              <TableCell className="text-right font-bold">{rupees(totalDue)}</TableCell>
              <TableCell colSpan={2} />
            </TableRow>
          </tfoot>
        )}
      </Table>
      <PaginationBar page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalPages={totalPages} total={total} />
    </div>
  );
}

interface PayTarget {
  id: string;
  lorry: string;
  due: number;
  sourced: FreightRow['sourced'];
  kind?: 'Husk' | 'Seed' | 'Dust';
  date: string;
  destination?: string | null;
}

export default function FreightDuesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const initialMainTab = tabParam === 'transport' || tabParam === 'lorries' ? tabParam : 'dues';
  const [mainTab, setMainTab] = useState(initialMainTab);
  const qc = useQueryClient();
  const [tab, setTab] = useState('outward');

  // Pay dialog state
  const [payTarget, setPayTarget] = useState<PayTarget | null>(null);
  const [payType, setPayType] = useState<'TRANSPORTER_INWARD' | 'TRANSPORTER_OUTWARD'>('TRANSPORTER_OUTWARD');
  const [payDate, setPayDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [payAmount, setPayAmount] = useState('');
  const [payReference, setPayReference] = useState('');

  const { data: purchases, isLoading: loadingPurchases } = useQuery({
    queryKey: ['purchases'],
    queryFn: () => api<PurchaseRow[]>('/purchases?all=true'),
  });
  const { data: saleOrders, isLoading: loadingSales } = useQuery({
    // Full history - /sale-orders is capped at the latest 100 by default, which
    // would drop older dispatches (and their outward freight) out of the dues run.
    queryKey: ['sale-orders', { all: true }],
    queryFn: () => api<SaleOrder[]>('/sale-orders?all=true'),
  });
  const { data: payments, isLoading: loadingPayments } = useQuery({
    // Full history - dues are matched against every payment, not just latest 100.
    queryKey: ['payments', { all: true }],
    queryFn: () => api<Payment[]>('/payments?all=true'),
  });
  const { data: company } = useQuery({
    queryKey: ['company'],
    queryFn: () => api<CompanyProfile>('/settings/company'),
  });
  // Transfer transport (husk / seed / pre-cleaner dust) is billed to KNM Transport
  // and settles from the same per-lorry pool as the usual KNM freight.
  const { data: huskTransfers } = useQuery({
    queryKey: ['husk-transfers'],
    queryFn: () => api<HuskTransfer[]>('/husk-transfers'),
  });
  const { data: shellTransfers } = useQuery({
    queryKey: ['shell-transfers'],
    queryFn: () => api<ShellTransfer[]>('/shell-transfers'),
  });
  const { data: stockTransfers } = useQuery({
    queryKey: ['stock-transfers'],
    queryFn: () => api<StockTransfer[]>('/stock-transfers'),
  });
  // Lorries booked over WhatsApp and not yet dispatched - badged on the tab so a
  // new booking is visible without opening it. Shares its key with the register,
  // so both read one cached response.
  const { data: waitingBookings } = useQuery({
    queryKey: ['lorry-confirmations', 'WAITING'],
    queryFn: () => api<LorryConfirmation[]>('/whatsapp/transport-confirmations?status=WAITING'),
    refetchInterval: 60_000,
  });
  const waitingLorries = waitingBookings?.length ?? 0;

  const isLoading = loadingPurchases || loadingSales || loadingPayments;

  // The full freight allocation (outward/inward/KNM split + per-lorry FIFO
  // payment matching) is heavy and depends only on the fetched data. Memoize it
  // so the payment dialog's keystrokes don't recompute the whole thing per
  // render. retention/knmList live inside so the memo stays referentially stable.
  const { outwardRows, inwardRows, knmRows, transferRows, rowStatus, rowDue, paymentsByLorry } = useMemo(() => {
  const retention = Number(company?.freightRetentionPerTrip ?? 3000);
  const knmList = companyVehicleNumbers(company?.companyVehicles);

  // Outward freight (sales). Hamali deducted off the lorry's freight = the lorry
  // share of the loading hamali (pappu ₹80/t, else flat ₹160/t); Transport = the
  // ₹3,000 retention held for Surya Road Transport. Net = lorry owner's payable.
  const allOutwardRows: FreightRow[] = (saleOrders ?? [])
    .flatMap((o) => (o.dispatches ?? []).map((d) => ({ o, d })))
    .filter(({ d }) => Number(d.freightCharge) > 0)
    .map(({ o, d }) => {
      const freight = Number(d.freightCharge);
      const provider = (d as any).transportProvider ?? (d.vehicleNumber && knmList.includes(d.vehicleNumber.trim().toLowerCase()) ? 'KNM' : 'SURYA');
      const isKnm = provider === 'KNM' || (d.vehicleNumber ? knmList.includes(d.vehicleNumber.trim().toLowerCase()) : false);
      const hamali = isKnm ? 0 : (o.product === 'PAPPU' ? pappuLoadingHamali(d.weightKg).lorry : calcHamali(d.weightKg));
      const kata = isKnm ? 0 : calcKataFee(d.weightKg);
      const transport = (d as any).customRetention != null ? Number((d as any).customRetention) : (provider === 'SURYA' ? retention : 0);
      return {
        id: d.id,
        date: d.dispatchDate,
        lorry: d.vehicleNumber?.trim().toUpperCase() ?? null,
        invoice: d.invoiceNumber ?? null,
        freight,
        hamali,
        kata,
        transport,
        net: round2(freight - hamali - kata - transport),
        deliveryStatus: d.status as SaleStatus,
        sourced: 'Sale',
        destination: o.destination ?? null,
        party: o.buyer?.name ?? null,
      };
    });

  // Inward freight (purchases). Hamali & kata are the recorded purchase charges;
  // no Surya transport retention applies inward.
  const allInwardRows: FreightRow[] = (purchases ?? [])
    .filter((p) => inwardFreightOf(p) > 0)
    .map((p) => {
      const freight = round2(inwardFreightOf(p));
      const lorry = p.stockIn?.lorryNumber;
      const isKnm = lorry ? knmList.includes(lorry.trim().toLowerCase()) : false;
      // For KNM vehicles, hamali and kata lorry shares are 0. (The backend stores the total hamali in p.hamaliCharge)
      const hamali = isKnm ? 0 : Number(p.hamaliCharge ?? 0);
      const kata = isKnm ? 0 : Number(p.kataFee ?? 0);
      return {
        id: p.id,
        date: p.stockIn?.arrivalDate ?? p.createdAt,
        lorry: lorry?.trim().toUpperCase() ?? null,
        invoice: p.stockIn?.invoiceNumber ?? null,
        freight,
        hamali,
        kata,
        transport: 0,
        net: round2(freight - hamali - kata),
        deliveryStatus: 'RECEIVED',
        sourced: 'Purchase',
        destination: p.stockIn?.loadingLocation ?? null,
        party: p.stockIn?.purchaseOrder?.party?.name ?? null,
      };
    });

  const knmRows = combineSharedLorryRows([
    ...allOutwardRows.filter(r => r.lorry && knmList.includes(r.lorry.toLowerCase())),
    ...allInwardRows.filter(r => r.lorry && knmList.includes(r.lorry.toLowerCase())),
  ]).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const outwardRows = combineSharedLorryRows(allOutwardRows.filter(r => !r.lorry || !knmList.includes(r.lorry.toLowerCase())));
  const inwardRows = combineSharedLorryRows(allInwardRows.filter(r => !r.lorry || !knmList.includes(r.lorry.toLowerCase())));

  // Transfer transport rows (husk / seed / pre-cleaner dust). The whole transport
  // charge is the net payable to KNM Transport - no hamali/kata/retention deducted.
  const mkTransferRow = (
    prefix: string,
    kind: 'Husk' | 'Seed' | 'Dust',
    t: { id: string; transferDate: string; lorryNumber: string | null; transportCharge: string | number; fromLocation: string; toLocation: string; weightKg: number },
  ): FreightRow => {
    const freight = round2(Number(t.transportCharge));
    return {
      id: `${prefix}-${t.id}`,
      date: t.transferDate,
      lorry: t.lorryNumber?.trim().toUpperCase() ?? null,
      invoice: null,
      freight,
      hamali: 0,
      kata: 0,
      transport: 0,
      net: freight,
      deliveryStatus: 'RECEIVED',
      sourced: 'Transfer',
      destination: `${t.fromLocation} → ${t.toLocation}`,
      party: 'KNM Transport',
      kind,
      weightKg: t.weightKg,
    };
  };
  const transferRows: FreightRow[] = [
    ...(huskTransfers ?? []).map((t) => mkTransferRow('husk', 'Husk', t)),
    ...(stockTransfers ?? []).map((t) => mkTransferRow('seed', 'Seed', t)),
    ...(shellTransfers ?? []).map((t) => mkTransferRow('dust', 'Dust', t)),
  ]
    .filter((r) => r.freight > 0)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  // Payment matching:
  // 1. Direct row payments (tagged with [rowId] in description or reference)
  // 2. Floating payments per lorry, separated into Usual Freight vs Transfer pools
  const rowStatus = new Map<string, PaymentStatus>();
  const rowDue = new Map<string, number>();
  const paymentsByLorry = new Map<string, { date: string, amount: number, reference: string | null }[]>();

  const directPaidByRow = new Map<string, number>();
  const floatingUsualByLorry = new Map<string, number>();
  const floatingTransferByLorry = new Map<string, number>();

  payments?.forEach((p) => {
    if ((p.type === 'TRANSPORTER' || p.type === 'TRANSPORTER_INWARD' || p.type === 'TRANSPORTER_OUTWARD') && p.lorryNumber) {
      const k = p.lorryNumber.trim().toUpperCase();
      const amt = Number(p.amount);
      
      const list = paymentsByLorry.get(k) || [];
      list.push({ date: p.date, amount: amt, reference: p.reference ?? null });
      paymentsByLorry.set(k, list);

      // Check if description contains direct row tag: e.g. [seed-cmt1gecun0007dq2dkq6urkth]
      const match = p.description?.match(/\[([a-zA-Z0-9_-]+)\]/);
      const rowId = match ? match[1] : null;

      if (rowId) {
        directPaidByRow.set(rowId, (directPaidByRow.get(rowId) ?? 0) + amt);
      } else if (p.description?.toLowerCase().includes('transfer')) {
        floatingTransferByLorry.set(k, (floatingTransferByLorry.get(k) ?? 0) + amt);
      } else {
        floatingUsualByLorry.set(k, (floatingUsualByLorry.get(k) ?? 0) + amt);
      }
    }
  });

  function allocatePool(rows: FreightRow[], floatingByLorry: Map<string, number>) {
    const remainingDueMap = new Map<string, number>();
    for (const r of rows) {
      const direct = directPaidByRow.get(r.id) ?? 0;
      const rem = round2(Math.max(0, r.net - direct));
      remainingDueMap.set(r.id, rem);
    }

    const rowsByLorry = new Map<string, FreightRow[]>();
    for (const r of rows) {
      if (r.lorry) {
        const list = rowsByLorry.get(r.lorry) || [];
        list.push(r);
        rowsByLorry.set(r.lorry, list);
      }
    }

    for (const [lorry, lorryRows] of rowsByLorry.entries()) {
      lorryRows.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
      let remainingPaid = floatingByLorry.get(lorry) ?? 0;

      for (const r of lorryRows) {
        const remAfterDirect = remainingDueMap.get(r.id) ?? r.net;
        const direct = directPaidByRow.get(r.id) ?? 0;

        if (remAfterDirect <= 0) {
          rowStatus.set(r.id, 'Paid');
          rowDue.set(r.id, 0);
        } else if (remainingPaid <= 0) {
          if (direct > 0) {
            rowStatus.set(r.id, 'Partial');
            rowDue.set(r.id, remAfterDirect);
          } else {
            rowStatus.set(r.id, 'Pending');
            rowDue.set(r.id, r.net);
          }
        } else if (remainingPaid + 0.01 >= remAfterDirect) {
          rowStatus.set(r.id, 'Paid');
          rowDue.set(r.id, 0);
          remainingPaid -= remAfterDirect;
        } else {
          rowStatus.set(r.id, 'Partial');
          rowDue.set(r.id, round2(remAfterDirect - remainingPaid));
          remainingPaid = 0;
        }
      }
    }
  }

  // Allocate Usual Freight Pool (Outward, Inward, KNM Usual)
  allocatePool([...inwardRows, ...outwardRows, ...knmRows], floatingUsualByLorry);

  // Allocate Transfer Pool (Husk, Seed, Dust Transfers)
  allocatePool(transferRows, floatingTransferByLorry);

  return { outwardRows, inwardRows, knmRows, transferRows, rowStatus, rowDue, paymentsByLorry };
  }, [saleOrders, purchases, payments, company, huskTransfers, shellTransfers, stockTransfers]);

  function paymentStatusFor(r: FreightRow): PaymentStatus {
    return r.lorry ? (rowStatus.get(r.id) ?? 'Pending') : 'Pending';
  }
  function dueFor(r: FreightRow): number {
    return r.lorry ? (rowDue.get(r.id) ?? r.net) : 0;
  }

  const payMutation = useMutation({
    mutationFn: () => {
      if (!payTarget) throw new Error('No trip selected for payment');
      const desc = payTarget.sourced === 'Transfer'
        ? `Transfer transport (${payTarget.kind || 'Internal'}) - Lorry ${payTarget.lorry} [${payTarget.id}]`
        : `Freight payment - Lorry ${payTarget.lorry} [${payTarget.id}]`;

      return api<Payment>('/payments', {
        method: 'POST',
        body: {
          date: payDate,
          amount: Number(payAmount) || 0,
          type: payType,
          lorryNumber: payTarget.lorry,
          reference: payReference || null,
          description: desc,
        },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['journal-entries'] });
      toast.success('Freight payment recorded');
      setPayTarget(null);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  function openPay(row: FreightRow, due: number) {
    if (!row.lorry) return;
    setPayTarget({
      id: row.id,
      lorry: row.lorry,
      due,
      sourced: row.sourced,
      kind: row.kind,
      date: row.date,
      destination: row.destination,
    });
    setPayType(row.sourced === 'Purchase' ? 'TRANSPORTER_INWARD' : 'TRANSPORTER_OUTWARD');
    setPayDate(row.date ? row.date.slice(0, 10) : new Date().toISOString().slice(0, 10));
    setPayAmount(due > 0 ? String(due) : '');
    setPayReference('');
  }

  const outwardNet = outwardRows.reduce((s, r) => s + r.net, 0);
  const outwardDue = outwardRows.reduce((s, r) => s + dueFor(r), 0);

  const inwardNet = inwardRows.reduce((s, r) => s + r.net, 0);
  const inwardDue = inwardRows.reduce((s, r) => s + dueFor(r), 0);

  const knmUsualNet = knmRows.reduce((s, r) => s + r.net, 0);
  const knmUsualDue = knmRows.reduce((s, r) => s + dueFor(r), 0);

  const transfersNet = transferRows.reduce((s, r) => s + r.net, 0);
  const transfersDue = transferRows.reduce((s, r) => s + dueFor(r), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Freight Dues"
        description="Transporter freight dues, net payable & transport retention report."
        icon={Truck}
      />

      <Tabs
        value={mainTab}
        onValueChange={(v) => {
          setMainTab(v);
          setSearchParams(v === 'dues' ? {} : { tab: v });
        }}
        className="space-y-6"
      >
        <TabsList className="bg-card border shadow-sm">
          <TabsTrigger value="dues" className="gap-2 text-sm font-semibold">
            <Truck className="h-4 w-4" /> Freight Dues
          </TabsTrigger>
          <TabsTrigger value="transport" className="gap-2 text-sm font-semibold">
            <Truck className="h-4 w-4" /> Transport Report
          </TabsTrigger>
          <TabsTrigger value="lorries" className="gap-2 text-sm font-semibold">
            <MessageCircle className="h-4 w-4" /> Lorry Confirmations
            {waitingLorries > 0 && (
              <Badge variant="secondary" className="ml-0.5 h-5 px-1.5 text-[10px]">{waitingLorries}</Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="dues" className="space-y-6">
          {isLoading ? (
            <div className="flex items-center justify-center h-48">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : (
            <Tabs value={tab} onValueChange={setTab} className="space-y-4">
              <TabsList>
                <TabsTrigger value="outward" className="gap-1.5">
                  <ArrowUpFromLine className="h-4 w-4" /> Outward (Sales)
                </TabsTrigger>
                <TabsTrigger value="inward" className="gap-1.5">
                  <ArrowDownToLine className="h-4 w-4" /> Inward (Purchases)
                </TabsTrigger>
                <TabsTrigger value="knm" className="gap-1.5">
                  <Truck className="h-4 w-4" /> KNM Freight
                </TabsTrigger>
              </TabsList>

              <TabsContent value="outward" className="space-y-4">
                <Card className="bg-card/50 border shadow-sm max-w-xs">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Outward Net Freight</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-xl font-bold">{rupees(outwardDue)}</div>
                    <div className="text-xs text-muted-foreground mt-1">Total: {rupees(outwardNet)}</div>
                  </CardContent>
                </Card>
                <FreightTable freightLabel="Outward Freight" exportName="Freight_Dues_Outward" rows={outwardRows} paymentStatusFor={paymentStatusFor} dueFor={dueFor} onPay={openPay} paymentsByLorry={paymentsByLorry} />
              </TabsContent>

              <TabsContent value="inward" className="space-y-4">
                <Card className="bg-card/50 border shadow-sm max-w-xs">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Inward Net Freight</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-xl font-bold">{rupees(inwardDue)}</div>
                    <div className="text-xs text-muted-foreground mt-1">Total: {rupees(inwardNet)}</div>
                  </CardContent>
                </Card>
                <FreightTable freightLabel="Inward Freight" exportName="Freight_Dues_Inward" rows={inwardRows} paymentStatusFor={paymentStatusFor} dueFor={dueFor} onPay={openPay} paymentsByLorry={paymentsByLorry} />
              </TabsContent>

              <TabsContent value="knm" className="space-y-6">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl">
                  <Card className="bg-card/50 border shadow-sm">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Usual Freight Due</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="text-xl font-bold">{rupees(knmUsualDue)}</div>
                      <div className="text-xs text-muted-foreground mt-1">Total: {rupees(knmUsualNet)}</div>
                    </CardContent>
                  </Card>
                  <Card className="bg-card/50 border shadow-sm">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Transfers Payable</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="text-xl font-bold">{rupees(transfersDue)}</div>
                      <div className="text-xs text-muted-foreground mt-1">Total: {rupees(transfersNet)}</div>
                    </CardContent>
                  </Card>
                  <Card className="bg-card/50 border shadow-sm">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">KNM Total Payable</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="text-xl font-bold">{rupees(knmUsualDue + transfersDue)}</div>
                      <div className="text-xs text-muted-foreground mt-1">Total: {rupees(knmUsualNet + transfersNet)}</div>
                    </CardContent>
                  </Card>
                </div>

                <Tabs defaultValue="usual" className="space-y-4">
                  <TabsList>
                    <TabsTrigger value="usual" className="gap-1.5">
                      <Truck className="h-4 w-4" /> Usual Freights
                    </TabsTrigger>
                    <TabsTrigger value="transfers" className="gap-1.5">
                      <ArrowLeftRight className="h-4 w-4" /> Transfers
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="usual">
                    <FreightTable freightLabel="KNM Freight" exportName="Freight_Dues_KNM" rows={knmRows} paymentStatusFor={paymentStatusFor} dueFor={dueFor} onPay={openPay} hideDeductions={true} paymentsByLorry={paymentsByLorry} />
                  </TabsContent>

                  <TabsContent value="transfers" className="space-y-2">
                    <p className="text-xs text-muted-foreground">Husk, seed &amp; pre-cleaner dust transport billed to KNM Transport.</p>
                    <TransfersTable rows={transferRows} paymentStatusFor={paymentStatusFor} dueFor={dueFor} onPay={openPay} paymentsByLorry={paymentsByLorry} />
                  </TabsContent>
                </Tabs>
              </TabsContent>
            </Tabs>
          )}
        </TabsContent>

        <TabsContent value="transport">
          <SuryaRoadTransport embedded />
        </TabsContent>

        <TabsContent value="lorries">
          <LorryConfirmations />
        </TabsContent>
      </Tabs>

      <Dialog open={payTarget !== null} onOpenChange={(o) => { if (!o) setPayTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              Pay {payTarget?.sourced === 'Transfer' ? `${payTarget.kind || ''} Transfer` : 'Freight'} - Lorry {payTarget?.lorry}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {payTarget && (
              <div className="rounded-md bg-muted/50 p-3 text-xs space-y-1 text-muted-foreground">
                <div className="flex justify-between">
                  <span>Date: <strong className="text-foreground">{shortDate(payTarget.date)}</strong></span>
                  <span>Type: <strong className="text-foreground">{payTarget.sourced === 'Transfer' ? `${payTarget.kind} Transfer` : payTarget.sourced}</strong></span>
                </div>
                {payTarget.destination && (
                  <div>Route: <strong className="text-foreground">{payTarget.destination}</strong></div>
                )}
                <div className="flex justify-between font-medium">
                  <span>Due Amount:</span>
                  <span className="text-rose-600 dark:text-rose-400 font-bold">{rupees(payTarget.due)}</span>
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="pay-date">Payment Date</Label>
                <Input id="pay-date" type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pay-amount">Amount (₹)</Label>
                <Input id="pay-amount" type="number" step="0.01" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} placeholder="e.g. 50000" />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="pay-ref">Reference (Cheque / UTR / Cash)</Label>
              <Input id="pay-ref" value={payReference} onChange={(e) => setPayReference(e.target.value)} placeholder="Optional" />
            </div>
            <DialogFooter>
              <Button onClick={() => payMutation.mutate()} disabled={!(Number(payAmount) > 0) || payMutation.isPending}>
                {payMutation.isPending ? 'Saving…' : 'Record Payment'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
