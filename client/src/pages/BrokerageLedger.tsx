import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { usePagedRows } from '@/lib/usePagedRows';
import { PaginationBar } from '@/components/ui/pagination-bar';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';
import type { Broker, SaleOrder, Payment } from '@/lib/types';
import { rupees, shortDate } from '@/lib/format';
import { openBrokerStatement, type BrokerStatementTxn, type StatementCompany } from '@/lib/brokerStatement';
import { WhatsAppIcon } from '@/components/icons/WhatsAppIcon';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Search, Loader2, ArrowLeft, Handshake, Phone, ReceiptText, Scale,
  Wallet, ArrowUpRight, ArrowDownRight, Users, IndianRupee, FileText,
} from 'lucide-react';

// "RVP" is the company's own-orders marker (not a real commission agent), so no
// brokerage is due on orders booked under it.
const isOwnBroker = (name?: string | null) => (name ?? '').trim().toUpperCase() === 'RVP';

/* ------------------------------------------------------------------ shared */

function balanceColor(type: 'DR' | 'CR') {
  return type === 'DR' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400';
}

function BalanceCell({ value, muted }: { value: number; muted?: boolean }) {
  if (value === 0) return <span className="text-muted-foreground tabular-nums">0.00</span>;
  const dr = value >= 0;
  return (
    <span className={`inline-flex items-baseline gap-1.5 tabular-nums ${muted ? 'text-muted-foreground' : `font-semibold ${balanceColor(dr ? 'DR' : 'CR')}`}`}>
      {rupees(Math.abs(value))}
      <span className={`text-[9px] font-bold px-1 py-0.5 rounded leading-none ${dr ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-rose-500/10 text-rose-600 dark:text-rose-400'}`}>
        {dr ? 'DR' : 'CR'}
      </span>
    </span>
  );
}

type Tone = 'neutral' | 'emerald' | 'rose' | 'blue';
const TONE_RING: Record<Tone, string> = {
  neutral: 'text-muted-foreground',
  emerald: 'text-emerald-600 dark:text-emerald-400',
  rose: 'text-rose-600 dark:text-rose-400',
  blue: 'text-blue-600 dark:text-blue-400',
};

function KpiCard({ icon: Icon, label, value, hint, sub, tone = 'neutral' }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string; value: string; hint?: string; sub?: string; tone?: Tone;
}) {
  return (
    <Card className="border shadow-sm">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
          <Icon className={`h-4 w-4 ${TONE_RING[tone]}`} />
        </div>
        <div className={`text-xl font-bold ${tone === 'neutral' ? '' : TONE_RING[tone]}`}>
          {value}{sub && <span className="text-xs font-semibold ml-1">{sub}</span>}
        </div>
        {hint && <p className="text-[10px] text-muted-foreground mt-1">{hint}</p>}
      </CardContent>
    </Card>
  );
}

/* ============================================================== root switch */

export default function BrokerageLedger() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selected = searchParams.get('broker');
  return selected
    ? <BrokerDetail brokerId={selected} onBack={() => setSearchParams({})} />
    : <BrokerIndex onSelect={(id) => setSearchParams({ broker: id })} />;
}

/* ================================================================ index view */

interface BrokerSummaryRow {
  id: string;
  name: string;
  phone: string | null;
  orderCount: number;
  lastActivity: string | null;
  totalDue: number;
  totalPaid: number;
  balance: number;
}

const INDEX_COLUMNS: ExportColumn<BrokerSummaryRow>[] = [
  { header: 'Broker', value: (r) => r.name },
  { header: 'Orders', value: (r) => String(r.orderCount) },
  { header: 'Last Activity', value: (r) => (r.lastActivity ? shortDate(r.lastActivity) : '') },
  { header: 'Total Due', value: (r) => rupees(r.totalDue), excel: (r) => r.totalDue, numFmt: '#,##0.00', align: 'right' },
  { header: 'Paid', value: (r) => rupees(r.totalPaid), excel: (r) => r.totalPaid, numFmt: '#,##0.00', align: 'right' },
  { header: 'Balance', value: (r) => rupees(r.balance), excel: (r) => r.balance, numFmt: '#,##0.00', align: 'right' },
];

function BrokerIndex({ onSelect }: { onSelect: (id: string) => void }) {
  const [q, setQ] = useState('');

  const { data: brokers, isLoading: loadingBrokers } = useQuery({
    queryKey: ['brokers'],
    queryFn: () => api<Broker[]>('/brokers'),
  });
  const { data: saleOrders, isLoading: loadingSales } = useQuery({
    // Full history - /sale-orders is capped at the latest 100 by default, which
    // silently dropped older orders (and their brokerage) off this report.
    queryKey: ['sale-orders', { all: true }],
    queryFn: () => api<SaleOrder[]>('/sale-orders?all=true'),
  });
  const { data: payments, isLoading: loadingPayments } = useQuery({
    // Full history - the ledger reflects every payment, not just latest 100.
    queryKey: ['payments', { all: true }],
    queryFn: () => api<Payment[]>('/payments?all=true'),
  });

  const isLoading = loadingBrokers || loadingSales || loadingPayments;

  const rows = useMemo<BrokerSummaryRow[]>(() => {
    return (brokers ?? [])
      .filter((b) => !isOwnBroker(b.name))
      .map((b) => {
        const dispatches = (saleOrders ?? [])
          .filter((o) => o.brokerId === b.id)
          .flatMap((o) => o.dispatches ?? []);
        const totalDue = dispatches.length * Number(b.brokerageAmount);
        const totalPaid = (payments ?? [])
          .filter((p) => p.type === 'BROKER' && p.brokerId === b.id)
          .reduce((s, p) => s + Number(p.amount), 0);
        const lastActivity = dispatches
          .map((d) => d.dispatchDate)
          .sort((a, c) => new Date(c).getTime() - new Date(a).getTime())[0] ?? null;
        return {
          id: b.id,
          name: b.name,
          phone: b.phone,
          orderCount: dispatches.length,
          lastActivity,
          totalDue,
          totalPaid,
          balance: totalDue - totalPaid,
        };
      })
      .filter((r) => {
        const term = q.trim().toLowerCase();
        if (!term) return true;
        return [r.name, r.phone].some((f) => f?.toLowerCase().includes(term));
      });
  }, [brokers, saleOrders, payments, q]);

  const totals = useMemo(() => {
    const due = rows.reduce((s, r) => s + r.totalDue, 0);
    const paid = rows.reduce((s, r) => s + r.totalPaid, 0);
    const balance = rows.reduce((s, r) => s + r.balance, 0);
    return { due, paid, balance, count: rows.length };
  }, [rows]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Brokerage Report</h1>
          <p className="text-muted-foreground">A complete account for every broker - dues, payments &amp; balance (each broker's own flat rate per dispatched order).</p>
        </div>
        <ExportButtons
          filename="Brokerage_Report"
          title="Brokerage Report"
          subtitle={`${rows.length} broker(s)`}
          columns={INDEX_COLUMNS}
          rows={rows}
        />
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard icon={Users} label="Total Brokers" value={String(totals.count)} tone="neutral" />
        <KpiCard icon={ArrowUpRight} label="Total Brokerage Earned" value={rupees(totals.due)} tone="neutral" />
        <KpiCard icon={ArrowDownRight} label="Total Paid" value={rupees(totals.paid)} tone="emerald" />
        <KpiCard icon={IndianRupee} label="Balance Payable" value={rupees(totals.balance)} tone="rose" hint="Owed by us to brokers" />
      </div>

      {/* search */}
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by broker name or phone…" className="pl-9" />
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead>Broker</TableHead>
              <TableHead>Orders</TableHead>
              <TableHead className="text-center">Last Activity</TableHead>
              <TableHead className="text-right">Total Due</TableHead>
              <TableHead className="text-right">Paid</TableHead>
              <TableHead className="text-right">Balance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6} className="h-40 text-center"><Loader2 className="h-7 w-7 animate-spin text-primary mx-auto" /></TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="h-32 text-center text-muted-foreground">No brokers match your search.</TableCell></TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.id} className="cursor-pointer" onClick={() => onSelect(r.id)}>
                  <TableCell>
                    <div className="font-semibold">{r.name}</div>
                    {r.phone && <div className="text-[11px] text-muted-foreground font-mono">{r.phone}</div>}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px] font-medium">{r.orderCount}</Badge>
                  </TableCell>
                  <TableCell className="text-center text-sm text-muted-foreground">{r.lastActivity ? shortDate(r.lastActivity) : '-'}</TableCell>
                  <TableCell className="text-right font-medium">{rupees(r.totalDue)}</TableCell>
                  <TableCell className="text-right text-emerald-600 dark:text-emerald-400">{rupees(r.totalPaid)}</TableCell>
                  <TableCell className="text-right">
                    {r.balance > 0.01 ? (
                      <span className="font-bold text-rose-600 dark:text-rose-400">{rupees(r.balance)} <span className="text-[10px] font-semibold">CR</span></span>
                    ) : (
                      <span className="text-muted-foreground">Settled</span>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/* =============================================================== detail view */

type BrokerTxn = BrokerStatementTxn;

const DETAIL_COLUMNS: ExportColumn<BrokerTxn>[] = [
  { header: 'Date', value: (t) => shortDate(t.date) },
  { header: 'Type', value: (t) => (t.kind === 'BROKERAGE' ? 'Brokerage' : 'Payment') },
  { header: 'Particulars', value: (t) => t.particulars },
  { header: 'Invoice No', value: (t) => t.invoiceNumber ?? '' },
  { header: 'Vehicle No', value: (t) => t.vehicleNumber ?? '' },
  { header: 'Reference', value: (t) => t.reference ?? '' },
  { header: 'Debit', value: (t) => (t.debit ? rupees(t.debit) : ''), excel: (t) => t.debit || null, numFmt: '#,##0.00', align: 'right' },
  { header: 'Credit', value: (t) => (t.credit ? rupees(t.credit) : ''), excel: (t) => t.credit || null, numFmt: '#,##0.00', align: 'right' },
  { header: 'Balance', value: (t) => `${rupees(Math.abs(t.runningBalance))} ${t.runningBalance >= 0 ? 'DR' : 'CR'}`, align: 'right' },
];

function BrokerDetail({ brokerId, onBack }: { brokerId: string; onBack: () => void }) {
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [waDialogOpen, setWaDialogOpen] = useState(false);

  const { data: brokers, isLoading: loadingBrokers } = useQuery({
    queryKey: ['brokers'],
    queryFn: () => api<Broker[]>('/brokers'),
  });
  const { data: saleOrders, isLoading: loadingSales } = useQuery({
    queryKey: ['sale-orders', { all: true }],
    queryFn: () => api<SaleOrder[]>('/sale-orders?all=true'),
  });
  const { data: payments, isLoading: loadingPayments } = useQuery({
    queryKey: ['payments', { all: true }],
    queryFn: () => api<Payment[]>('/payments?all=true'),
  });
  // Letterhead + "remit to" bank block on the printed statement.
  const { data: company } = useQuery({
    queryKey: ['settings', 'company'],
    queryFn: () => api<StatementCompany>('/settings/company'),
    staleTime: 5 * 60 * 1000,
  });

  const isLoading = loadingBrokers || loadingSales || loadingPayments;
  const broker = brokers?.find((b) => b.id === brokerId);

  // Brokerage-due lines (one per dispatch) and payment lines, sorted chronologically
  // with a running balance - same Dr/Cr mechanics as a supplier's party ledger:
  // brokerage owed = Cr, payment made = Dr.
  const allTxns = useMemo<BrokerTxn[]>(() => {
    const lines: Omit<BrokerTxn, 'runningBalance'>[] = [];

    (saleOrders ?? [])
      .filter((o) => o.brokerId === brokerId)
      .forEach((o) => {
        (o.dispatches ?? []).forEach((d) => {
          lines.push({
            id: `BROKERAGE-${d.id}`,
            date: d.dispatchDate,
            kind: 'BROKERAGE',
            particulars: `Brokerage - Sale to ${o.buyer?.name ?? '-'}`,
            invoiceNumber: d.invoiceNumber,
            vehicleNumber: d.vehicleNumber,
            reference: null,
            debit: 0,
            credit: Number(broker?.brokerageAmount ?? 0),
          });
        });
      });

    (payments ?? [])
      .filter((p) => p.type === 'BROKER' && p.brokerId === brokerId)
      .forEach((p) => {
        lines.push({
          id: `PAYMENT-${p.id}`,
          date: p.date,
          kind: 'PAYMENT',
          particulars: 'Payment',
          invoiceNumber: null,
          vehicleNumber: null,
          reference: p.reference ?? p.description ?? null,
          debit: Number(p.amount),
          credit: 0,
        });
      });

    lines.sort((a, c) => new Date(a.date).getTime() - new Date(c.date).getTime());

    let running = 0;
    return lines.map((l) => {
      running += l.debit - l.credit;
      return { ...l, runningBalance: running };
    });
  }, [saleOrders, payments, brokerId, broker]);

  const filtered = useMemo(() => {
    let t = allTxns;
    if (from) t = t.filter((x) => x.date >= from);
    if (to) t = t.filter((x) => x.date <= to + 'T23:59:59');
    const term = q.trim().toLowerCase();
    if (term) {
      t = t.filter((x) =>
        [x.particulars, x.invoiceNumber, x.vehicleNumber, x.reference].some((f) => f?.toLowerCase().includes(term)),
      );
    }
    return t;
  }, [allTxns, q, from, to]);

  const { page, setPage, pageSize, setPageSize, totalPages, total, pageRows: visible = [] } = usePagedRows(filtered, 50);

  if (isLoading || !broker) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  const totalDue = allTxns.reduce((s, t) => s + t.credit, 0);
  const totalPaid = allTxns.reduce((s, t) => s + t.debit, 0);
  const balance = totalDue - totalPaid; // positive = still payable (Cr)

  const filteredDebit = filtered.reduce((s, t) => s + t.debit, 0);
  const filteredCredit = filtered.reduce((s, t) => s + t.credit, 0);
  const opening = filtered.length ? filtered[0].runningBalance - filtered[0].debit + filtered[0].credit : 0;
  const closing = filtered.length ? filtered[filtered.length - 1].runningBalance : 0;
  const periodText = filtered.length
    ? `${shortDate(filtered[0].date)} – ${shortDate(filtered[filtered.length - 1].date)}`
    : '';
  const orderCount = allTxns.filter((t) => t.kind === 'BROKERAGE').length;
  const lastActivity = allTxns.length ? allTxns[allTxns.length - 1].date : null;

  return (
    <div className="space-y-6">
      {/* toolbar */}
      <div className="flex items-center justify-between gap-3 print:hidden">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> All Brokers
        </Button>
        <div className="flex gap-2">
          <ExportButtons
            filename={`${broker.name.replace(/\s+/g, '_')}_Brokerage_Ledger`}
            title={`Brokerage Ledger - ${broker.name}`}
            subtitle={periodText}
            columns={DETAIL_COLUMNS}
            rows={filtered}
            showPdf={false}
            showPrint={false}
          />
          <Button
            size="sm"
            className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-medium shadow-sm"
            onClick={() => setWaDialogOpen(true)}
          >
            <WhatsAppIcon className="h-4 w-4 fill-white" /> WhatsApp Ledger
          </Button>
          <Button
            size="sm"
            className="gap-1.5"
            onClick={() => {
              try {
                openBrokerStatement({
                  company,
                  broker,
                  summary: { totalDue, totalPaid, orderCount, lastActivity },
                  transactions: filtered,
                  fromDate: from || undefined,
                  toDate: to || undefined,
                });
              } catch (e) {
                toast.error(e instanceof Error ? e.message : 'Could not open the statement.');
              }
            }}
          >
            <FileText className="h-4 w-4" /> Statement (PDF)
          </Button>
        </div>
      </div>

      {/* profile header */}
      <div className="rounded-xl border bg-gradient-to-br from-primary/5 via-card to-card overflow-hidden">
        <div className="p-6 flex flex-col lg:flex-row lg:items-start gap-6">
          <div className="flex items-start gap-4 flex-1">
            <div className="h-14 w-14 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <Handshake className="h-7 w-7" />
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-2xl font-bold tracking-tight">{broker.name}</h1>
                <Badge variant="outline" className="font-medium">Broker</Badge>
              </div>
              {broker.phone && (
                <div className="flex flex-wrap gap-x-6 gap-y-1.5 text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5"><Phone className="h-3.5 w-3.5" /> {broker.phone}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          icon={balance > 0.01 ? ArrowDownRight : Wallet}
          label="Balance Payable"
          value={balance > 0.01 ? rupees(balance) : 'Settled'}
          sub={balance > 0.01 ? 'CR' : undefined}
          tone={balance <= 0.01 ? 'neutral' : 'rose'}
        />
        <KpiCard icon={Scale} label="Brokerage Earned" value={rupees(totalDue)} tone="neutral" hint={`${allTxns.filter((t) => t.kind === 'BROKERAGE').length} orders`} />
        <KpiCard icon={ReceiptText} label="Total Paid" value={rupees(totalPaid)} tone="emerald" />
        <KpiCard icon={IndianRupee} label="Rate" value={`${rupees(Number(broker?.brokerageAmount ?? 0))}`} sub="/ order" tone="blue" />
      </div>

      {/* filters */}
      <div className="flex flex-col lg:flex-row gap-3 print:hidden">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search invoice, vehicle, reference…" className="pl-9" />
        </div>
        <div className="flex items-center gap-2">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" title="From date" />
          <span className="text-muted-foreground text-sm">–</span>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" title="To date" />
        </div>
      </div>

      {/* statement */}
      <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b bg-gradient-to-r from-primary/[0.07] via-card to-card flex items-end justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2">
              <ReceiptText className="h-4 w-4 text-primary" />
              <span className="font-semibold tracking-tight">Account Statement</span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {periodText ? `${broker.name} · ${periodText}` : broker.name}
            </p>
          </div>
          <div className="text-right">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Closing Balance</div>
            <div className={`text-lg font-bold tabular-nums ${closing === 0 ? '' : balanceColor(closing >= 0 ? 'DR' : 'CR')}`}>
              {closing === 0 ? 'Settled' : <>{rupees(Math.abs(closing))} <span className="text-xs font-semibold">{closing >= 0 ? 'DR' : 'CR'}</span></>}
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-28">Date</TableHead>
                <TableHead className="min-w-[260px]">Particulars</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead className="text-right border-l border-border/60 bg-secondary">Debit</TableHead>
                <TableHead className="text-right bg-secondary">Credit</TableHead>
                <TableHead className="text-right border-l border-border/60 bg-secondary">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="h-28 text-center text-muted-foreground">No transactions for the selected filters.</TableCell></TableRow>
              ) : (
                <>
                  <TableRow className="bg-muted/30 hover:bg-muted/30">
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{shortDate(filtered[0].date)}</TableCell>
                    <TableCell className="text-xs font-medium text-muted-foreground italic" colSpan={2}>Opening Balance</TableCell>
                    <TableCell className="border-l border-border/60 bg-muted/20" />
                    <TableCell className="bg-muted/20" />
                    <TableCell className="text-right border-l border-border/60 bg-muted/20"><BalanceCell value={opening} muted /></TableCell>
                  </TableRow>

                  {visible.map((t, i) => <TxnRow key={t.id} t={t} zebra={i % 2 === 1} />)}

                  <TableRow className="bg-primary/[0.06] hover:bg-primary/[0.06] border-t-2 border-border">
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap font-medium">{shortDate(filtered[filtered.length - 1].date)}</TableCell>
                    <TableCell className="text-sm font-semibold" colSpan={2}>Closing Balance</TableCell>
                    <TableCell className="text-right border-l border-border/60 font-semibold tabular-nums">{filteredDebit > 0 ? rupees(filteredDebit) : ''}</TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">{filteredCredit > 0 ? rupees(filteredCredit) : ''}</TableCell>
                    <TableCell className="text-right border-l border-border/60"><BalanceCell value={closing} /></TableCell>
                  </TableRow>
                </>
              )}
            </TableBody>
          </Table>
          <PaginationBar page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalPages={totalPages} total={total} />
        </div>

        {filtered.length > 0 && (
          <div className="grid grid-cols-3 divide-x divide-border border-t bg-muted/20">
            <SummaryStat label="Total Debit" value={rupees(filteredDebit)} />
            <SummaryStat label="Total Credit" value={rupees(filteredCredit)} />
            <SummaryStat
              label="Net Balance"
              value={closing === 0 ? 'Settled' : `${rupees(Math.abs(closing))} ${closing >= 0 ? 'DR' : 'CR'}`}
              tone={closing === 0 ? undefined : closing >= 0 ? 'emerald' : 'rose'}
            />
          </div>
        )}
      </div>

      <SendBrokerLedgerWhatsAppDialog
        open={waDialogOpen}
        onOpenChange={setWaDialogOpen}
        broker={broker}
        initialFrom={from}
        initialTo={to}
        allTxns={allTxns}
        company={company}
      />
    </div>
  );
}

const KIND_META: Record<BrokerTxn['kind'], { label: string; cls: string }> = {
  BROKERAGE: { label: 'Brokerage', cls: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20' },
  PAYMENT: { label: 'Payment', cls: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20' },
};

function TxnRow({ t, zebra }: { t: BrokerTxn; zebra?: boolean }) {
  const meta = KIND_META[t.kind];
  const refs = [
    t.invoiceNumber && { label: 'Inv', value: t.invoiceNumber },
    t.vehicleNumber && { label: 'Veh', value: t.vehicleNumber },
    t.reference && { label: 'Ref', value: t.reference },
  ].filter(Boolean) as { label: string; value: string }[];

  return (
    <TableRow className={zebra ? 'bg-muted/[0.18]' : undefined}>
      <TableCell className="align-top text-sm whitespace-nowrap text-muted-foreground">{shortDate(t.date)}</TableCell>
      <TableCell className="align-top">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={`text-[10px] font-semibold ${meta.cls}`}>{meta.label}</Badge>
        </div>
        <div className="text-[13px] text-foreground/90 mt-1.5 leading-snug whitespace-normal">{t.particulars}</div>
      </TableCell>
      <TableCell className="align-top">
        {refs.length ? (
          <div className="space-y-0.5">
            {refs.map((r) => (
              <div key={r.label} className="flex items-baseline gap-1.5 text-[11px]">
                <span className="text-muted-foreground w-7 shrink-0">{r.label}</span>
                <span className="font-mono text-foreground/80 break-all">{r.value}</span>
              </div>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground text-xs">-</span>
        )}
      </TableCell>
      <TableCell className="align-top text-right tabular-nums border-l border-border/60">
        {t.debit > 0 ? <span className="font-semibold text-foreground">{rupees(t.debit)}</span> : <span className="text-muted-foreground/50">-</span>}
      </TableCell>
      <TableCell className="align-top text-right tabular-nums">
        {t.credit > 0 ? <span className="font-semibold text-foreground">{rupees(t.credit)}</span> : <span className="text-muted-foreground/50">-</span>}
      </TableCell>
      <TableCell className="align-top text-right border-l border-border/60">
        <BalanceCell value={t.runningBalance} />
      </TableCell>
    </TableRow>
  );
}

function SummaryStat({ label, value, tone }: { label: string; value: string; tone?: 'emerald' | 'rose' }) {
  return (
    <div className="px-5 py-3.5 text-center">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-base font-bold tabular-nums mt-0.5 ${tone ? TONE_RING[tone] : ''}`}>{value}</div>
    </div>
  );
}

/* =================================================== WhatsApp Send Dialog */

function SendBrokerLedgerWhatsAppDialog({
  open,
  onOpenChange,
  broker,
  initialFrom,
  initialTo,
  allTxns,
  company,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  broker: Broker;
  initialFrom: string;
  initialTo: string;
  allTxns: BrokerTxn[];
  company: StatementCompany | null | undefined;
}) {
  const [fromDate, setFromDate] = useState(initialFrom);
  const [toDate, setToDate] = useState(initialTo || new Date().toISOString().slice(0, 10));
  const [phone, setPhone] = useState(broker.phone || '');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setFromDate(initialFrom);
      setToDate(initialTo || new Date().toISOString().slice(0, 10));
      setPhone(broker.phone || '');
    }
  }, [open, initialFrom, initialTo, broker]);

  // Date window only, over every voucher - the statement PDF's opening balance
  // won't reconcile to its closing figure if a voucher type gets dropped, so
  // the preview is scoped exactly like what actually goes out.
  const periodTxns = useMemo(() => {
    let t = allTxns;
    if (fromDate) t = t.filter((x) => x.date >= fromDate);
    if (toDate) t = t.filter((x) => x.date <= toDate + 'T23:59:59');
    return t;
  }, [allTxns, fromDate, toDate]);

  const opening = periodTxns.length ? periodTxns[0].runningBalance - periodTxns[0].debit + periodTxns[0].credit : 0;
  const closing = periodTxns.length ? periodTxns[periodTxns.length - 1].runningBalance : 0;
  const totalBrokerage = periodTxns.reduce((s, x) => s + x.credit, 0);
  const totalPaid = periodTxns.reduce((s, x) => s + x.debit, 0);

  const handleSendApi = async () => {
    if (!phone.trim()) {
      toast.error('Please enter a valid phone number');
      return;
    }
    setLoading(true);
    try {
      const res = await api<{ ok: boolean; message: string }>(
        `/whatsapp/brokers/${broker.id}/send-ledger`,
        { method: 'POST', body: { fromDate, toDate, phone: phone.trim() } }
      );
      if (!res.ok) {
        toast.error(res.message || 'WhatsApp send failed');
        return;
      }
      toast.success(res.message || 'Brokerage statement sent!');
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to send WhatsApp message');
    } finally {
      setLoading(false);
    }
  };

  const handleOpenWhatsAppWeb = () => {
    const rawNumber = phone.trim() || broker.phone || '';
    let num = rawNumber.replace(/\D/g, '');
    if (num.length === 10) num = `91${num}`;

    const fromStr = fromDate || (periodTxns.length ? periodTxns[0].date.slice(0, 10) : 'Start');
    const toStr = toDate || (periodTxns.length ? periodTxns[periodTxns.length - 1].date.slice(0, 10) : 'Today');

    const msg = `*BROKERAGE STATEMENT - ${broker.name.toUpperCase()}*\nPeriod: ${fromStr} to ${toStr}\nOpening Bal: ₹${Math.abs(opening).toLocaleString('en-IN')} ${opening >= 0 ? 'Dr' : 'Cr'}\nTotal Brokerage: ₹${totalBrokerage.toLocaleString('en-IN')}\nTotal Paid: ₹${totalPaid.toLocaleString('en-IN')}\n*Closing Bal: ₹${Math.abs(closing).toLocaleString('en-IN')} ${closing >= 0 ? 'Dr' : 'Cr'}*\n\nThank you,\n*${company?.name || 'RVP INDUSTRIES'}*`;

    window.open(`https://wa.me/${num}?text=${encodeURIComponent(msg)}`, '_blank');
  };

  const handleOpenPdf = () => {
    const totalDue = allTxns.reduce((s, t) => s + t.credit, 0);
    const totalPaidAll = allTxns.reduce((s, t) => s + t.debit, 0);
    const orderCount = allTxns.filter((t) => t.kind === 'BROKERAGE').length;
    const lastActivity = allTxns.length ? allTxns[allTxns.length - 1].date : null;
    openBrokerStatement({
      company,
      broker,
      summary: { totalDue, totalPaid: totalPaidAll, orderCount, lastActivity },
      transactions: periodTxns,
      fromDate: fromDate || undefined,
      toDate: toDate || undefined,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-emerald-600">
            <WhatsAppIcon className="h-5 w-5 fill-emerald-600" />
            Send Brokerage Ledger via WhatsApp
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="rounded-lg border bg-muted/30 p-3 space-y-1">
            <div className="font-semibold text-sm">{broker.name}</div>
            <div className="text-xs text-muted-foreground">Select period and confirm recipient phone number below.</div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-muted-foreground">From Date</label>
              <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-muted-foreground">To Date</label>
              <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-muted-foreground">Recipient WhatsApp Mobile</label>
            <Input
              type="text"
              placeholder="e.g. 9876543210"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>

          <div className="rounded-lg border bg-emerald-500/5 p-3 space-y-2 text-xs">
            <div className="font-semibold text-emerald-700 dark:text-emerald-400 uppercase tracking-wider text-[11px]">
              Statement Summary ({periodTxns.length} transactions)
            </div>
            <div className="grid grid-cols-2 gap-2 text-muted-foreground">
              <div>Opening: <span className="font-medium text-foreground">₹{Math.abs(opening).toLocaleString('en-IN')} {opening >= 0 ? 'Dr' : 'Cr'}</span></div>
              <div>Closing: <span className="font-bold text-foreground">₹{Math.abs(closing).toLocaleString('en-IN')} {closing >= 0 ? 'Dr' : 'Cr'}</span></div>
              <div>Brokerage: <span className="font-medium text-foreground">₹{totalBrokerage.toLocaleString('en-IN')}</span></div>
              <div>Paid: <span className="font-medium text-foreground">₹{totalPaid.toLocaleString('en-IN')}</span></div>
            </div>
          </div>

          <div className="flex flex-col gap-2 pt-2">
            <Button
              onClick={handleSendApi}
              disabled={loading}
              className="w-full gap-2 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <WhatsAppIcon className="h-4 w-4 fill-white" />}
              Send Statement PDF on WhatsApp
            </Button>
            <p className="text-[11px] text-muted-foreground text-center -mt-0.5">
              Attaches the full brokerage statement for this period as a PDF - both
              voucher types, so the opening and closing balances reconcile.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" size="sm" onClick={handleOpenWhatsAppWeb} className="gap-1.5">
                <WhatsAppIcon className="h-3.5 w-3.5 fill-emerald-600" /> WhatsApp Web
              </Button>
              <Button variant="outline" size="sm" onClick={handleOpenPdf} className="gap-1.5">
                <FileText className="h-3.5 w-3.5" /> View/Print PDF
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
