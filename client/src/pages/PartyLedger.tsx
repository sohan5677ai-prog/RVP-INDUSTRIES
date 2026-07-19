import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { PartyLedgerRow, PartyLedgerDetail, PartyLedgerTxn, LedgerKind } from '@/lib/types';
import { rupees, shortDate } from '@/lib/format';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';
import {
  Search, Loader2, ArrowLeft, Printer, Phone, MapPin, Landmark,
  Hash, Wallet, TrendingUp, TrendingDown, Scale, Building2,
  ArrowDownRight, ArrowUpRight, ReceiptText, Copy, Check, Users, IndianRupee,
  BellRing,
} from 'lucide-react';

/* ------------------------------------------------------------------ helpers */

const KIND_META: Record<LedgerKind, { label: string; cls: string }> = {
  PURCHASE: { label: 'Purchase', cls: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20' },
  SALE: { label: 'Sale', cls: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20' },
  PAYMENT: { label: 'Payment', cls: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20' },
  RECEIPT: { label: 'Receipt', cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20' },
  CREDIT_NOTE: { label: 'Credit Note', cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20' },
};

const TYPE_LABEL: Record<string, string> = { SUPPLIER: 'Supplier', BUYER: 'Buyer', BOTH: 'Supplier & Buyer' };

const LEDGER_COLUMNS: ExportColumn<PartyLedgerTxn>[] = [
  { header: 'Date', value: (t) => shortDate(t.date) },
  { header: 'Type', value: (t) => KIND_META[t.kind].label },
  { header: 'Particulars', value: (t) => t.particulars },
  { header: 'Invoice No', value: (t) => t.invoiceNumber ?? '' },
  { header: 'Vehicle No', value: (t) => t.vehicleNumber ?? '' },
  { header: 'UTR / Ref', value: (t) => t.utr ?? t.reference ?? '' },
  { header: 'Weight (kg)', value: (t) => t.weightKg ?? '', excel: (t) => t.weightKg ?? null, numFmt: '#,##0', align: 'right' },
  { header: 'Rate', value: (t) => (t.ratePerKg != null ? rupees(t.ratePerKg) : ''), excel: (t) => t.ratePerKg ?? null, numFmt: '#,##0.00', align: 'right' },
  { header: 'Debit', value: (t) => (t.debit ? rupees(t.debit) : ''), excel: (t) => t.debit || null, numFmt: '#,##0.00', align: 'right' },
  { header: 'Credit', value: (t) => (t.credit ? rupees(t.credit) : ''), excel: (t) => t.credit || null, numFmt: '#,##0.00', align: 'right' },
  { header: 'Balance', value: (t) => `${rupees(Math.abs(t.runningBalance))} ${t.runningBalance >= 0 ? 'DR' : 'CR'}`, align: 'right' },
];

function balanceColor(type: 'DR' | 'CR') {
  return type === 'DR' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400';
}

function CopyBtn({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => { navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1200); }}
      className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
      title="Copy"
    >
      {done ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

/* ============================================================== root switch */

export default function PartyLedger() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selected = searchParams.get('party');
  return selected
    ? <PartyDetail partyId={selected} onBack={() => setSearchParams({})} />
    : <PartyIndex onSelect={(id) => setSearchParams({ party: id })} />;
}

/* ================================================================ index view */

function PartyIndex({ onSelect }: { onSelect: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('ALL');

  const { data, isLoading } = useQuery({
    queryKey: ['party-ledgers'],
    queryFn: () => api<PartyLedgerRow[]>('/ledger/parties'),
  });

  const rows = useMemo(() => {
    let r = data ?? [];
    if (typeFilter !== 'ALL') {
      r = r.filter((p) => p.type === typeFilter || p.type === 'BOTH');
    }
    const term = q.trim().toLowerCase();
    if (term) {
      r = r.filter((p) =>
        [p.name, p.phone, p.address, p.state, p.gstin, p.bankAccountNumber]
          .some((f) => f?.toLowerCase().includes(term)),
      );
    }
    return r;
  }, [data, q, typeFilter]);

  const totals = useMemo(() => {
    const r = data ?? [];
    const receivable = r.filter((p) => p.balanceType === 'DR').reduce((s, p) => s + p.balance, 0);
    const payable = r.filter((p) => p.balanceType === 'CR').reduce((s, p) => s + p.balance, 0);
    const business = r.reduce((s, p) => s + p.totalBusiness, 0);
    return { receivable, payable, business, count: r.length };
  }, [data]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Party Ledger</h1>
        <p className="text-muted-foreground">A complete A-to-Z account for every supplier and buyer - balances, statements & bank details.</p>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard icon={Users} label="Total Parties" value={String(totals.count)} tone="neutral" />
        <KpiCard icon={ArrowUpRight} label="Total Receivable" value={rupees(totals.receivable)} tone="emerald" hint="Owed to us by buyers" />
        <KpiCard icon={ArrowDownRight} label="Total Payable" value={rupees(totals.payable)} tone="rose" hint="Owed by us to suppliers" />
        <KpiCard icon={IndianRupee} label="Lifetime Business" value={rupees(totals.business)} tone="neutral" />
      </div>

      {/* search + filter */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, phone, GSTIN, bank A/C, location…" className="pl-9" />
        </div>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-full sm:w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Parties</SelectItem>
            <SelectItem value="SUPPLIER">Suppliers</SelectItem>
            <SelectItem value="BUYER">Buyers</SelectItem>
            <SelectItem value="BOTH">Supplier & Buyer</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead>Party</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Contact</TableHead>
              <TableHead>Location</TableHead>
              <TableHead className="text-center">Last Activity</TableHead>
              <TableHead className="text-right">Total Business</TableHead>
              <TableHead className="text-right">Balance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={7} className="h-40 text-center"><Loader2 className="h-7 w-7 animate-spin text-primary mx-auto" /></TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="h-32 text-center text-muted-foreground">No parties match your search.</TableCell></TableRow>
            ) : (
              rows.map((p) => (
                <TableRow key={p.id} className="cursor-pointer" onClick={() => onSelect(p.id)}>
                  <TableCell>
                    <div className="font-semibold">{p.name}</div>
                    {p.gstin && <div className="text-[11px] text-muted-foreground font-mono">{p.gstin}</div>}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px] font-medium">{TYPE_LABEL[p.type] ?? p.type}</Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{p.phone ?? '-'}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{[p.address, p.state].filter(Boolean).join(', ') || '-'}</TableCell>
                  <TableCell className="text-center text-sm text-muted-foreground">{p.lastTxnDate ? shortDate(p.lastTxnDate) : '-'}</TableCell>
                  <TableCell className="text-right font-medium">{rupees(p.totalBusiness)}</TableCell>
                  <TableCell className="text-right">
                    {p.balance > 0 ? (
                      <span className={`font-bold ${balanceColor(p.balanceType)}`}>{rupees(p.balance)} <span className="text-[10px] font-semibold">{p.balanceType}</span></span>
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

const KIND_FILTERS: { value: string; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'PURCHASE', label: 'Purchases' },
  { value: 'SALE', label: 'Sales' },
  { value: 'PAYMENT', label: 'Payments' },
  { value: 'RECEIPT', label: 'Receipts' },
];

function PartyDetail({ partyId, onBack }: { partyId: string; onBack: () => void }) {
  const [kind, setKind] = useState<string>('ALL');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['party-ledger', partyId],
    queryFn: () => api<PartyLedgerDetail>(`/ledger/parties/${partyId}`),
  });

  // WhatsApp "remind about pending loads" — server computes the pending lorries
  // and throttles repeat sends.
  const remindMutation = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; pendingLorries: number; poLabel: string }>(
        `/whatsapp/parties/${partyId}/reminder`,
        { method: 'POST' }
      ),
    onSuccess: (r) =>
      toast.success(`Reminder sent — ${r.pendingLorries} pending lorries (${r.poLabel})`),
    onError: (e: Error) => toast.error(e.message),
  });

  const filtered = useMemo(() => {
    let t = data?.transactions ?? [];
    if (kind !== 'ALL') t = t.filter((x) => x.kind === kind || (kind === 'RECEIPT' && x.kind === 'CREDIT_NOTE'));
    if (from) t = t.filter((x) => x.date >= from);
    if (to) t = t.filter((x) => x.date <= to + 'T23:59:59');
    const term = q.trim().toLowerCase();
    if (term) {
      t = t.filter((x) =>
        [x.particulars, x.invoiceNumber, x.vehicleNumber, x.utr, x.reference, x.product]
          .some((f) => f?.toLowerCase().includes(term)),
      );
    }
    return t;
  }, [data, kind, q, from, to]);

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  const { party, summary } = data;
  const filteredDebit = filtered.reduce((s, t) => s + t.debit, 0);
  const filteredCredit = filtered.reduce((s, t) => s + t.credit, 0);
  // Opening = running balance just before the first row; closing = last row's running balance.
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
          <ArrowLeft className="h-4 w-4" /> All Parties
        </Button>
        <div className="flex gap-2">
          {party.type !== 'BUYER' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (confirm(`Send ${party.name} a WhatsApp reminder about their pending loads?`)) {
                  remindMutation.mutate();
                }
              }}
              disabled={remindMutation.isPending}
              className="gap-1.5"
            >
              {remindMutation.isPending
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <BellRing className="h-4 w-4" />}
              Remind Pending Loads
            </Button>
          )}
          <ExportButtons
            filename={`${party.name.replace(/\s+/g, '_')}_Ledger`}
            title={`Party Ledger — ${party.name}`}
            subtitle={periodText}
            columns={LEDGER_COLUMNS}
            rows={filtered}
            showPrint={false}
          />
          <Button variant="outline" size="sm" onClick={() => window.print()} className="gap-1.5"><Printer className="h-4 w-4" /> Print</Button>
        </div>
      </div>

      {/* profile header */}
      <div className="rounded-xl border bg-gradient-to-br from-primary/5 via-card to-card overflow-hidden">
        <div className="p-6 flex flex-col lg:flex-row lg:items-start gap-6">
          <div className="flex items-start gap-4 flex-1">
            <div className="h-14 w-14 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <Building2 className="h-7 w-7" />
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-2xl font-bold tracking-tight">{party.name}</h1>
                <Badge variant="outline" className="font-medium">{TYPE_LABEL[party.type] ?? party.type}</Badge>
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-1.5 text-sm text-muted-foreground">
                {party.phone && <span className="inline-flex items-center gap-1.5"><Phone className="h-3.5 w-3.5" /> {party.phone}</span>}
                {(party.address || party.state) && <span className="inline-flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5" /> {[party.address, party.state].filter(Boolean).join(', ')}</span>}
                {party.gstin && <span className="inline-flex items-center gap-1.5 group font-mono"><Hash className="h-3.5 w-3.5" /> {party.gstin} <CopyBtn value={party.gstin} /></span>}
              </div>
            </div>
          </div>

          {/* bank details */}
          <div className="lg:w-80 shrink-0 rounded-lg border bg-background/60 p-4 space-y-2.5">
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <Landmark className="h-3.5 w-3.5" /> Bank Details
            </div>
            {party.bankAccountNumber || party.bankName || party.bankIfsc ? (
              <div className="space-y-1.5 text-sm">
                {party.bankName && <Info label="Bank" value={party.bankName} />}
                {party.bankAccountNumber && <Info label="A/C No" value={party.bankAccountNumber} mono copy />}
                {party.bankIfsc && <Info label="IFSC" value={party.bankIfsc} mono copy />}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground italic">No bank details on file.</p>
            )}
          </div>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          icon={summary.balanceType === 'DR' ? TrendingUp : TrendingDown}
          label={summary.balanceType === 'DR' ? 'Receivable (they owe)' : 'Payable (we owe)'}
          value={summary.balance > 0 ? rupees(summary.balance) : 'Settled'}
          sub={summary.balance > 0 ? summary.balanceType : undefined}
          tone={summary.balance === 0 ? 'neutral' : summary.balanceType === 'DR' ? 'emerald' : 'rose'}
        />
        <KpiCard icon={Scale} label="Lifetime Business" value={rupees(summary.totalBusiness)} tone="neutral" hint={`${summary.transactionCount} transactions`} />
        <KpiCard icon={ReceiptText} label={party.type === 'BUYER' ? 'Total Sold' : 'Total Purchased'} value={rupees(party.type === 'BUYER' ? summary.saleTotal : summary.purchaseTotal)} tone="blue" />
        <KpiCard icon={Wallet} label={party.type === 'BUYER' ? 'Total Received' : 'Total Paid'} value={rupees(party.type === 'BUYER' ? summary.receivedTotal : summary.paidTotal)} tone="neutral" hint={summary.pendingCount > 0 ? `${summary.pendingCount} awaiting verification` : undefined} />
      </div>

      {/* filters */}
      <div className="flex flex-col lg:flex-row gap-3 print:hidden">
        <div className="inline-flex rounded-lg border bg-card p-1 self-start">
          {KIND_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setKind(f.value)}
              className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors ${kind === f.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search invoice, vehicle, UTR…" className="pl-9" />
        </div>
        <div className="flex items-center gap-2">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" title="From date" />
          <span className="text-muted-foreground text-sm">–</span>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" title="To date" />
        </div>
      </div>

      {/* statement */}
      <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
        {/* statement header band */}
        <div className="px-5 py-4 border-b bg-gradient-to-r from-primary/[0.07] via-card to-card flex items-end justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2">
              <ReceiptText className="h-4 w-4 text-primary" />
              <span className="font-semibold tracking-tight">Account Statement</span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {periodText ? `${party.name} · ${periodText}` : party.name}
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
                <TableHead className="text-right border-l border-border/60 bg-muted/60">Debit</TableHead>
                <TableHead className="text-right bg-muted/60">Credit</TableHead>
                <TableHead className="text-right border-l border-border/60 bg-muted/60">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="h-28 text-center text-muted-foreground">No transactions for the selected filters.</TableCell></TableRow>
              ) : (
                <>
                  {/* opening balance */}
                  <TableRow className="bg-muted/30 hover:bg-muted/30">
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{shortDate(filtered[0].date)}</TableCell>
                    <TableCell className="text-xs font-medium text-muted-foreground italic" colSpan={2}>Opening Balance</TableCell>
                    <TableCell className="border-l border-border/60 bg-muted/20" />
                    <TableCell className="bg-muted/20" />
                    <TableCell className="text-right border-l border-border/60 bg-muted/20"><BalanceCell value={opening} muted /></TableCell>
                  </TableRow>

                  {filtered.map((t, i) => <TxnRow key={t.id} t={t} zebra={i % 2 === 1} />)}

                  {/* closing balance */}
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

function TxnRow({ t, zebra }: { t: PartyLedgerTxn; zebra?: boolean }) {
  const meta = KIND_META[t.kind];
  const refs = [
    t.invoiceNumber && { label: 'Inv', value: t.invoiceNumber },
    t.vehicleNumber && { label: 'Veh', value: t.vehicleNumber },
    t.utr && { label: 'UTR', value: t.utr },
  ].filter(Boolean) as { label: string; value: string }[];

  return (
    <TableRow className={zebra ? 'bg-muted/[0.18]' : undefined}>
      <TableCell className="align-top text-sm whitespace-nowrap text-muted-foreground">{shortDate(t.date)}</TableCell>
      <TableCell className="align-top">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={`text-[10px] font-semibold ${meta.cls}`}>{meta.label}</Badge>
          {t.status === 'PENDING' && <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-600 dark:text-amber-400">Awaiting</Badge>}
        </div>
        <div className="text-[13px] text-foreground/90 mt-1.5 leading-snug whitespace-normal">{t.particulars}</div>
        {t.weightKg != null && (
          <div className="text-[11px] text-muted-foreground mt-0.5">
            {t.weightKg.toLocaleString('en-IN')} kg{t.ratePerKg ? ` @ ₹${t.ratePerKg}/kg` : ''}
          </div>
        )}
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
            {t.transferredDate && (
              <div className="flex items-baseline gap-1.5 text-[11px]">
                <span className="text-muted-foreground w-7 shrink-0">Dt</span>
                <span className="text-muted-foreground">{shortDate(t.transferredDate)}</span>
              </div>
            )}
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

/* -------------------------------------------------------------- small bits */

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

function SummaryStat({ label, value, tone }: { label: string; value: string; tone?: 'emerald' | 'rose' }) {
  return (
    <div className="px-5 py-3.5 text-center">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-base font-bold tabular-nums mt-0.5 ${tone ? TONE_RING[tone] : ''}`}>{value}</div>
    </div>
  );
}

function Info({ label, value, mono, copy }: { label: string; value: string; mono?: boolean; copy?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 group">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className={`flex items-center gap-1.5 ${mono ? 'font-mono' : ''}`}>
        {value}
        {copy && <CopyBtn value={value} />}
      </span>
    </div>
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
