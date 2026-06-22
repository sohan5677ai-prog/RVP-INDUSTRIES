import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { PartyLedgerRow, PartyLedgerDetail, PartyLedgerTxn, LedgerKind } from '@/lib/types';
import { rupees, shortDate } from '@/lib/format';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Search, Loader2, ArrowLeft, Printer, Download, Phone, MapPin, Landmark,
  Hash, Wallet, TrendingUp, TrendingDown, Scale, Building2,
  ArrowDownRight, ArrowUpRight, ReceiptText, Copy, Check, Users, IndianRupee,
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
  const [selected, setSelected] = useState<string | null>(null);
  return selected
    ? <PartyDetail partyId={selected} onBack={() => setSelected(null)} />
    : <PartyIndex onSelect={setSelected} />;
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
        <p className="text-muted-foreground">A complete A-to-Z account for every supplier and buyer — balances, statements & bank details.</p>
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
                  <TableCell className="text-sm text-muted-foreground">{p.phone ?? '—'}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{[p.address, p.state].filter(Boolean).join(', ') || '—'}</TableCell>
                  <TableCell className="text-center text-sm text-muted-foreground">{p.lastTxnDate ? shortDate(p.lastTxnDate) : '—'}</TableCell>
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

  function exportCsv() {
    const head = ['Date', 'Type', 'Particulars', 'Invoice No', 'Vehicle No', 'UTR / Ref', 'Transferred Date', 'Weight (kg)', 'Rate', 'Debit', 'Credit', 'Balance'];
    const lines = filtered.map((t) => [
      shortDate(t.date), KIND_META[t.kind].label, t.particulars, t.invoiceNumber ?? '', t.vehicleNumber ?? '',
      t.utr ?? '', t.transferredDate ? shortDate(t.transferredDate) : '', t.weightKg ?? '', t.ratePerKg ?? '',
      t.debit || '', t.credit || '', `${Math.abs(t.runningBalance)} ${t.runningBalance >= 0 ? 'DR' : 'CR'}`,
    ]);
    const csv = [head, ...lines].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = `${party.name.replace(/\s+/g, '_')}_ledger.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      {/* toolbar */}
      <div className="flex items-center justify-between gap-3 print:hidden">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> All Parties
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={exportCsv} className="gap-1.5"><Download className="h-4 w-4" /> CSV</Button>
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
      <div className="rounded-xl border bg-card overflow-x-auto">
        <div className="px-5 py-3.5 border-b flex items-center justify-between bg-muted/30">
          <span className="font-semibold text-sm">Account Statement</span>
          <span className="text-xs text-muted-foreground">{filtered.length} entries</span>
        </div>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-24">Date</TableHead>
              <TableHead>Particulars</TableHead>
              <TableHead>Invoice No</TableHead>
              <TableHead>Vehicle No</TableHead>
              <TableHead>UTR / Ref · Transferred</TableHead>
              <TableHead className="text-right">Debit</TableHead>
              <TableHead className="text-right">Credit</TableHead>
              <TableHead className="text-right">Balance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow><TableCell colSpan={8} className="h-28 text-center text-muted-foreground">No transactions for the selected filters.</TableCell></TableRow>
            ) : (
              filtered.map((t) => <TxnRow key={t.id} t={t} />)
            )}
          </TableBody>
        </Table>
        {filtered.length > 0 && (
          <div className="border-t bg-muted/30 px-5 py-3 flex flex-wrap items-center justify-end gap-x-8 gap-y-1 text-sm">
            <span className="text-muted-foreground">Total Debit <span className="font-semibold text-foreground ml-1">{rupees(filteredDebit)}</span></span>
            <span className="text-muted-foreground">Total Credit <span className="font-semibold text-foreground ml-1">{rupees(filteredCredit)}</span></span>
            <span className="text-muted-foreground">Closing Balance
              <span className={`font-bold ml-1 ${balanceColor(summary.balanceType)}`}>
                {summary.balance > 0 ? `${rupees(summary.balance)} ${summary.balanceType}` : 'Settled'}
              </span>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function TxnRow({ t }: { t: PartyLedgerTxn }) {
  const meta = KIND_META[t.kind];
  return (
    <TableRow>
      <TableCell className="text-sm whitespace-nowrap">{shortDate(t.date)}</TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={`text-[10px] font-medium ${meta.cls}`}>{meta.label}</Badge>
          {t.status === 'PENDING' && <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-600 dark:text-amber-400">Awaiting</Badge>}
        </div>
        <div className="text-xs text-muted-foreground mt-1">
          {t.particulars}
          {t.weightKg != null && <span> · {t.weightKg.toLocaleString('en-IN')} kg{t.ratePerKg ? ` @ ₹${t.ratePerKg}` : ''}</span>}
        </div>
      </TableCell>
      <TableCell className="font-mono text-xs">{t.invoiceNumber ?? '—'}</TableCell>
      <TableCell className="font-mono text-xs">{t.vehicleNumber ?? '—'}</TableCell>
      <TableCell className="text-xs">
        {t.utr ? (
          <div>
            <div className="font-mono">{t.utr}</div>
            {t.transferredDate && <div className="text-muted-foreground">{shortDate(t.transferredDate)}</div>}
          </div>
        ) : '—'}
      </TableCell>
      <TableCell className="text-right font-medium tabular-nums">{t.debit > 0 ? rupees(t.debit) : '—'}</TableCell>
      <TableCell className="text-right font-medium tabular-nums">{t.credit > 0 ? rupees(t.credit) : '—'}</TableCell>
      <TableCell className="text-right tabular-nums">
        {t.runningBalance === 0 ? (
          <span className="text-muted-foreground">0</span>
        ) : (
          <span className={`font-semibold ${balanceColor(t.runningBalance >= 0 ? 'DR' : 'CR')}`}>
            {rupees(Math.abs(t.runningBalance))} <span className="text-[10px]">{t.runningBalance >= 0 ? 'DR' : 'CR'}</span>
          </span>
        )}
      </TableCell>
    </TableRow>
  );
}

/* -------------------------------------------------------------- small bits */

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
