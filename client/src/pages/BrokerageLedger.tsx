import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { usePagedRows } from '@/lib/usePagedRows';
import { PaginationBar } from '@/components/ui/pagination-bar';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';
import type { Broker, SaleOrder, Payment } from '@/lib/types';
import { rupees, shortDate } from '@/lib/format';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Search, Loader2, ArrowLeft, Handshake, Phone, ReceiptText, Scale,
  Wallet, ArrowUpRight, ArrowDownRight, Users, IndianRupee,
} from 'lucide-react';

// Flat ₹2,000 brokerage per sale order dispatch. Payments to the broker reduce
// the payable, exactly like a supplier ledger (brokerage = Cr, payment = Dr).
const FLAT_BROKERAGE = 2000;

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
        const totalDue = dispatches.length * FLAT_BROKERAGE;
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
          <p className="text-muted-foreground">A complete account for every broker - dues, payments &amp; balance (₹2,000 flat per dispatched order).</p>
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

interface BrokerTxn {
  id: string;
  date: string;
  kind: 'BROKERAGE' | 'PAYMENT';
  particulars: string;
  invoiceNumber: string | null;
  vehicleNumber: string | null;
  reference: string | null;
  debit: number;
  credit: number;
  runningBalance: number;
}

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
            credit: FLAT_BROKERAGE,
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
  }, [saleOrders, payments, brokerId]);

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

  return (
    <div className="space-y-6">
      {/* toolbar */}
      <div className="flex items-center justify-between gap-3 print:hidden">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> All Brokers
        </Button>
        <ExportButtons
          filename={`${broker.name.replace(/\s+/g, '_')}_Brokerage_Ledger`}
          title={`Brokerage Ledger - ${broker.name}`}
          subtitle={periodText}
          columns={DETAIL_COLUMNS}
          rows={filtered}
        />
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
        <KpiCard icon={IndianRupee} label="Rate" value={`${rupees(FLAT_BROKERAGE)}`} sub="/ order" tone="blue" />
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
