import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { Party, PartyLedgerRow, PartyLedgerDetail, PartyLedgerTxn, LedgerKind } from '@/lib/types';
import { rupees, shortDate } from '@/lib/format';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Segmented } from '@/components/ui/segmented';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';
import { openPartyStatement, type StatementCompany } from '@/lib/partyStatement';
import { WhatsAppIcon } from '@/components/icons/WhatsAppIcon';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  Search, Loader2, ArrowLeft, FileText, Phone, MapPin, Landmark,
  Hash, Wallet, TrendingUp, TrendingDown, Scale, Building2,
  ArrowDownRight, ArrowUpRight, ReceiptText, Copy, Check, Users, IndianRupee,
  BellRing, AlertTriangle,
} from 'lucide-react';

/* ------------------------------------------------------------------ helpers */

const KIND_META: Record<LedgerKind, { label: string; cls: string }> = {
  PURCHASE: { label: 'Purchase', cls: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20' },
  SALE: { label: 'Sale', cls: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20' },
  PAYMENT: { label: 'Payment', cls: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20' },
  RECEIPT: { label: 'Receipt', cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20' },
  CREDIT_NOTE: { label: 'Credit Note', cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20' },
  TDS: { label: 'TDS', cls: 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20' },
  SHORTAGE: { label: 'Shortage', cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20' },
  // Appears as a matched pair (one Dr, one Cr), so the running balance is
  // untouched - the knock-off settles the bills, not the net position.
  SET_OFF: { label: 'Set-off', cls: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20' },
};

const TYPE_LABEL: Record<string, string> = { SUPPLIER: 'Supplier', BUYER: 'Buyer', BOTH: 'Supplier & Buyer' };

/**
 * What the two WhatsApp reminder buttons may do for this party, computed server-
 * side. Both buttons are hidden unless there is actually something to remind
 * about - no pending lorries means no "Remind Pending Loads", no outstanding
 * sale invoice means no "Payment Reminder".
 */
/** One unsettled sale invoice, as offered to the payment-reminder picker. */
interface DueInvoiceLine {
  dispatchId: string;
  invoiceNumber: string;
  outstanding: number;
  dueDate: string;
  overdue: boolean;
  /** Dispatched but not delivered - billed, but the credit clock hasn't started,
   *  so it can never be overdue and dueDate is only a placeholder. */
  inTransit: boolean;
  brokerId: string | null;
  brokerName: string | null;
}

interface PartyReminderContext {
  party: { id: string; name: string; phone: string | null; phone2: string | null };
  pending: {
    lorries: number;
    breakdown: string;
    pos: { poNumber: string | null; pricePerKg: number; remaining: number }[];
  };
  dues: {
    /** OVERDUE once any invoice is past its due date; UPCOMING while all are still inside credit. */
    scope: 'OVERDUE' | 'UPCOMING';
    amount: number;
    invoiceCount: number;
    /** Comma-separated single line - exactly what the message will say. */
    invoiceListText: string;
    outstanding: number;
    overdueOutstanding: number;
    inTransitOutstanding: number;
    overdueCount: number;
    totalInvoiceCount: number;
    /** Every unsettled invoice, overdue and upcoming both - the picker's source list. */
    invoices: DueInvoiceLine[];
    /** Full per-broker totals across all their invoices (not scoped to overdue). */
    brokers: { id: string; name: string; phone: string | null; invoiceCount: number; outstanding: number }[];
  } | null;
}

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
        [p.name, p.phone, p.phone2, p.address, p.state, p.gstin, p.bankAccountNumber]
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
              <TableHead>Location</TableHead>
              <TableHead className="text-center">Last Activity</TableHead>
              <TableHead className="text-right">Total Business</TableHead>
              <TableHead className="text-right">Balance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6} className="h-40 text-center"><Loader2 className="h-7 w-7 animate-spin text-primary mx-auto" /></TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="h-32 text-center text-muted-foreground">No parties match your search.</TableCell></TableRow>
            ) : (
              rows.map((p) => (
                <TableRow key={p.id} className="cursor-pointer" onClick={() => onSelect(p.id)}>
                  <TableCell>
                    <div className="font-semibold">{p.name}</div>
                    {p.gstin && <div className="text-[11px] text-muted-foreground font-sans font-medium tracking-wide">{p.gstin}</div>}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px] font-medium">{TYPE_LABEL[p.type] ?? p.type}</Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{p.state || '-'}</TableCell>
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
  { value: 'SET_OFF', label: 'Set-offs' },
];

function PartyDetail({ partyId, onBack }: { partyId: string; onBack: () => void }) {
  const [kind, setKind] = useState<string>('ALL');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [waDialogOpen, setWaDialogOpen] = useState(false);
  const [payDialogOpen, setPayDialogOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['party-ledger', partyId],
    queryFn: () => api<PartyLedgerDetail>(`/ledger/parties/${partyId}`),
  });

  // Decides which reminder buttons are offered: pending lorries and outstanding
  // sale invoices are both server-computed, so the page never shows a send the
  // server would refuse.
  const { data: reminderCtx } = useQuery({
    queryKey: ['party-reminder-context', partyId],
    queryFn: () => api<PartyReminderContext>(`/whatsapp/parties/${partyId}/reminder-context`),
  });

  // Letterhead + "remit to" bank block on the printed statement.
  const { data: company } = useQuery({
    queryKey: ['settings', 'company'],
    queryFn: () => api<StatementCompany>('/settings/company'),
    staleTime: 5 * 60 * 1000,
  });

  // WhatsApp "remind about pending loads" - server computes the pending lorries
  // and throttles repeat sends.
  const remindMutation = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; pendingLorries: number; breakdown: string }>(
        `/whatsapp/parties/${partyId}/reminder`,
        { method: 'POST' }
      ),
    onSuccess: (r) =>
      toast.success(`Reminder sent - ${r.pendingLorries} pending lorr${r.pendingLorries === 1 ? 'y' : 'ies'}`),
    onError: (e: Error) => toast.error(e.message),
  });

  const pendingLorries = reminderCtx?.pending.lorries ?? 0;
  const dues = reminderCtx?.dues ?? null;

  const filtered = useMemo(() => {
    let t = data?.transactions ?? [];
    if (kind !== 'ALL') t = t.filter((x) => x.kind === kind || (kind === 'RECEIPT' && (x.kind === 'CREDIT_NOTE' || x.kind === 'TDS' || x.kind === 'SHORTAGE')));
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
          {/* Only when lorries are actually still to arrive against a PENDING PO. */}
          {pendingLorries > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (confirm(`Send ${party.name} a WhatsApp reminder about their ${pendingLorries} pending load${pendingLorries === 1 ? '' : 's'}?`)) {
                  remindMutation.mutate();
                }
              }}
              disabled={remindMutation.isPending}
              className="gap-1.5"
            >
              {remindMutation.isPending
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <BellRing className="h-4 w-4" />}
              Remind Pending Loads ({pendingLorries})
            </Button>
          )}
          {/* Only when this party has unsettled sale invoices. */}
          {dues && dues.totalInvoiceCount > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPayDialogOpen(true)}
              className="gap-1.5 border-amber-500/40 text-amber-700 dark:text-amber-400 hover:bg-amber-500/10"
            >
              <IndianRupee className="h-4 w-4" />
              Payment Reminder ({dues.totalInvoiceCount})
            </Button>
          )}
          <ExportButtons
            filename={`${party.name.replace(/\s+/g, '_')}_Ledger`}
            title={`Party Ledger - ${party.name}`}
            subtitle={periodText}
            columns={LEDGER_COLUMNS}
            rows={filtered}
            showPdf={false}
            showPrint={false}
          />
          <Button
            size="sm"
            className="gap-1.5"
            onClick={() => {
              try {
                openPartyStatement({
                  company,
                  party,
                  summary,
                  transactions: filtered,
                  filterNote: kind === 'ALL' ? undefined : KIND_FILTERS.find((f) => f.value === kind)?.label,
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
          <Button
            size="sm"
            className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-medium shadow-sm"
            onClick={() => setWaDialogOpen(true)}
          >
            <WhatsAppIcon className="h-4 w-4 fill-white" /> WhatsApp Ledger
          </Button>
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
                {(party.phone || party.phone2) && (
                  <span className="inline-flex items-center gap-1.5">
                    <Phone className="h-3.5 w-3.5" /> {[party.phone, party.phone2].filter(Boolean).join(' / ')}
                  </span>
                )}
                {(party.address || party.state) && <span className="inline-flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5" /> {[party.address, party.state].filter(Boolean).join(', ')}</span>}
                {party.gstin && <span className="inline-flex items-center gap-1.5 group font-sans font-medium tracking-wide"><Hash className="h-3.5 w-3.5" /> {party.gstin} <CopyBtn value={party.gstin} /></span>}
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
        <KpiCard
          icon={Wallet}
          label={party.type === 'BUYER' ? 'Total Received' : 'Total Paid'}
          value={rupees(party.type === 'BUYER' ? summary.receivedTotal : summary.paidTotal)}
          tone="neutral"
          // Cash only. A knock-off settles bills without money moving, so it is
          // called out separately rather than inflating this figure.
          hint={
            summary.setOffTotal > 0
              ? `${rupees(summary.setOffTotal)} settled by set-off`
              : summary.pendingCount > 0
                ? `${summary.pendingCount} awaiting verification`
                : undefined
          }
        />
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

      <SendPartyLedgerWhatsAppDialog
        open={waDialogOpen}
        onOpenChange={setWaDialogOpen}
        party={party}
        initialFrom={from}
        initialTo={to}
        summary={summary}
        transactions={data.transactions}
        company={company}
      />

      {dues && (
        <SendPaymentReminderDialog
          open={payDialogOpen}
          onOpenChange={setPayDialogOpen}
          partyId={partyId}
          partyName={party.name}
          partyPhone={party.phone ?? party.phone2 ?? null}
          dues={dues}
        />
      )}
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

/* ============================================= Payment Reminder Dialog */

type ReminderTarget = 'PARTY' | 'BROKER' | 'BOTH';

/**
 * "Payment Reminder" on the Party Ledger - shown only when the party has
 * unsettled sale invoices. The sender picks who gets chased: the party, the
 * broker(s) who stand behind those invoices, or both. Each broker is messaged
 * about their own invoices only, so one broker never sees another's business.
 */
function SendPaymentReminderDialog({
  open,
  onOpenChange,
  partyId,
  partyName,
  partyPhone,
  dues,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  partyId: string;
  partyName: string;
  partyPhone: string | null;
  dues: NonNullable<PartyReminderContext['dues']>;
}) {
  const [target, setTarget] = useState<ReminderTarget>('PARTY');
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Reset on open: overdue invoices are pre-checked - they're the ones the
  // template's "due date has passed" wording actually fits. If nothing is
  // overdue yet, fall back to the bills inside their credit period but leave
  // in-transit shipments unticked: the buyer hasn't received those goods, so
  // asking for the money is not a default worth making. Only if EVERY invoice
  // is in transit does the picker start fully checked, so it is never empty.
  useEffect(() => {
    if (!open) return;
    setTarget('PARTY');
    const overdueIds = dues.invoices.filter((i) => i.overdue).map((i) => i.dispatchId);
    const landedIds = dues.invoices.filter((i) => !i.inTransit).map((i) => i.dispatchId);
    const defaults = overdueIds.length > 0 ? overdueIds
      : landedIds.length > 0 ? landedIds
      : dues.invoices.map((i) => i.dispatchId);
    setSelected(new Set(defaults));
  }, [open, dues.invoices]);

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allChecked = dues.invoices.length > 0 && selected.size === dues.invoices.length;
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(dues.invoices.map((i) => i.dispatchId)));

  const selectedInvoices = dues.invoices.filter((i) => selected.has(i.dispatchId));
  const amount = selectedInvoices.reduce((s, i) => s + i.outstanding, 0);
  const hasOverdueSelected = selectedInvoices.some((i) => i.overdue);
  const inTransitSelected = selectedInvoices.filter((i) => i.inTransit);
  // Delivered but still inside the credit period. In-transit shipments are
  // excluded - they get their own, more specific warning below, and firing both
  // banners for the same invoice just doubles the noise.
  const hasUpcomingSelected = selectedInvoices.some((i) => !i.overdue && !i.inTransit);

  // Brokers behind the SELECTED invoices only - picking an invoice outside the
  // default overdue scope can bring a broker into play that wasn't offered
  // before, and unchecking their invoices should drop them again.
  const brokers = useMemo(() => {
    const byId = new Map<string, { id: string; name: string; phone: string | null; invoiceCount: number; outstanding: number }>();
    for (const inv of selectedInvoices) {
      if (!inv.brokerId) continue;
      const phone = dues.brokers.find((b) => b.id === inv.brokerId)?.phone ?? null;
      const row = byId.get(inv.brokerId) ?? { id: inv.brokerId, name: inv.brokerName ?? 'Broker', phone, invoiceCount: 0, outstanding: 0 };
      row.invoiceCount += 1;
      row.outstanding += inv.outstanding;
      byId.set(inv.brokerId, row);
    }
    return [...byId.values()];
  }, [selectedInvoices, dues.brokers]);
  const reachableBrokers = brokers.filter((b) => b.phone);

  // A target that's no longer valid for the current selection (its only
  // broker got unchecked) falls back to the party rather than staying stuck.
  useEffect(() => {
    if (target !== 'PARTY' && brokers.length === 0) setTarget('PARTY');
  }, [target, brokers.length]);

  const options: { label: string; value: ReminderTarget }[] = [
    { label: 'Party', value: 'PARTY' },
    ...(brokers.length > 0
      ? ([{ label: brokers.length === 1 ? 'Broker' : 'Brokers', value: 'BROKER' }, { label: 'Both', value: 'BOTH' }] as const)
      : []),
  ];

  const handleSend = async () => {
    setLoading(true);
    try {
      const res = await api<{ ok: boolean; message: string; failed: { recipient: string; error: string }[] }>(
        `/whatsapp/parties/${partyId}/payment-reminder`,
        { method: 'POST', body: { target, dispatchIds: [...selected] } }
      );
      if (res.failed.length > 0) toast.warning(res.message);
      else toast.success(res.message);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to send the payment reminder');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-emerald-600">
            <WhatsAppIcon className="h-5 w-5 fill-emerald-600" />
            Send Payment Reminder
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="rounded-lg border bg-muted/30 p-3 space-y-1.5">
            <div className="font-semibold text-sm">{partyName}</div>
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-muted-foreground">
                {selectedInvoices.length} of {dues.totalInvoiceCount} invoice{dues.totalInvoiceCount === 1 ? '' : 's'} selected
              </span>
              <span className="font-bold tabular-nums">{rupees(amount)}</span>
            </div>
          </div>

          {inTransitSelected.length > 0 && (
            <div className="rounded-lg border border-sky-500/40 bg-sky-500/10 p-3 flex gap-2 text-xs text-sky-700 dark:text-sky-400">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>
                {inTransitSelected.length === 1
                  ? `${inTransitSelected[0].invoiceNumber} has not been delivered yet`
                  : `${inTransitSelected.length} selected invoices have not been delivered yet`}
                {' '}- the buyer hasn't received the goods and their credit period hasn't started. Untick unless
                you mean to chase a shipment still on the road.
              </span>
            </div>
          )}

          {hasUpcomingSelected && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 flex gap-2 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>
                {hasOverdueSelected ? 'Some selected invoices are' : 'None of the selected invoices are'} past their due
                date yet. The approved template still reads "the due date has passed" - send only if you mean to nudge early.
              </span>
            </div>
          )}

          {/* Which invoices to quote - overdue ones pre-checked, everything else opt-in. */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-muted-foreground">Invoices</label>
              <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={toggleAll}
                  className="w-3.5 h-3.5 rounded border-gray-300 text-primary focus:ring-primary"
                />
                All
              </label>
            </div>
            <div className="rounded-lg border divide-y max-h-56 overflow-y-auto">
              {dues.invoices.map((inv) => (
                <label
                  key={inv.dispatchId}
                  className="flex items-center gap-2.5 px-3 py-2 text-xs cursor-pointer hover:bg-muted/40"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(inv.dispatchId)}
                    onChange={() => toggleOne(inv.dispatchId)}
                    className="w-3.5 h-3.5 shrink-0 rounded border-gray-300 text-primary focus:ring-primary"
                  />
                  <span className="font-mono font-medium flex-1 truncate">{inv.invoiceNumber}</span>
                  <span
                    className={`text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0 whitespace-nowrap ${
                      inv.overdue
                        ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400'
                        : inv.inTransit
                        ? 'bg-sky-500/10 text-sky-600 dark:text-sky-400'
                        : 'bg-muted text-muted-foreground'
                    }`}
                    title={inv.inTransit ? 'Not delivered yet - no due date until delivery is recorded' : undefined}
                  >
                    {inv.overdue ? 'Overdue' : inv.inTransit ? 'In Transit' : `Due ${shortDate(inv.dueDate)}`}
                  </span>
                  <span className="font-semibold tabular-nums shrink-0 w-20 text-right">{rupees(inv.outstanding)}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-semibold text-muted-foreground">Send to</label>
            {options.length > 1 ? (
              <Segmented options={options} value={target} onValueChange={(v) => setTarget(v)} />
            ) : (
              <p className="text-xs text-muted-foreground">
                {dues.brokers.length === 0
                  ? 'These are our own orders - there is no broker to copy, so the reminder goes to the party.'
                  : 'None of the selected invoices are brokered - the reminder goes to the party.'}
              </p>
            )}
          </div>

          {/* Exactly who will be messaged, with the numbers it goes to. */}
          <div className="rounded-lg border bg-card p-3 space-y-2 text-xs">
            {(target === 'PARTY' || target === 'BOTH') && (
              <RecipientLine
                name={partyName}
                phone={partyPhone}
                detail={`${rupees(amount)} · ${selectedInvoices.length} invoice${selectedInvoices.length === 1 ? '' : 's'}`}
              />
            )}
            {(target === 'BROKER' || target === 'BOTH') &&
              brokers.map((b) => (
                <RecipientLine
                  key={b.id}
                  name={b.name}
                  phone={b.phone}
                  detail={`${rupees(b.outstanding)} · ${b.invoiceCount} invoice${b.invoiceCount === 1 ? '' : 's'} brokered`}
                />
              ))}
          </div>

          <Button
            onClick={handleSend}
            disabled={loading || selected.size === 0 || (target === 'BROKER' && reachableBrokers.length === 0)}
            className="w-full gap-2 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <WhatsAppIcon className="h-4 w-4 fill-white" />}
            Send Payment Reminder{selected.size > 0 ? ` (${selected.size})` : ''}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** One line of the "who gets this" preview - a missing phone is called out, not hidden. */
function RecipientLine({ name, phone, detail }: { name: string; phone: string | null; detail: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <div className="font-semibold">{name}</div>
        <div className="text-muted-foreground">{detail}</div>
      </div>
      {phone ? (
        <span className="font-mono text-muted-foreground whitespace-nowrap">{phone}</span>
      ) : (
        <span className="text-rose-600 dark:text-rose-400 whitespace-nowrap">No phone on file</span>
      )}
    </div>
  );
}

/* =================================================== WhatsApp Send Dialog */

function SendPartyLedgerWhatsAppDialog({
  open,
  onOpenChange,
  party,
  initialFrom,
  initialTo,
  summary,
  transactions,
  company,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  party: Party;
  initialFrom: string;
  initialTo: string;
  summary: PartyLedgerDetail['summary'];
  transactions: PartyLedgerTxn[];
  company: StatementCompany | null | undefined;
}) {
  const [fromDate, setFromDate] = useState(initialFrom);
  const [toDate, setToDate] = useState(initialTo || new Date().toISOString().slice(0, 10));
  const [phone, setPhone] = useState(party.phone || party.phone2 || '');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setFromDate(initialFrom);
      setToDate(initialTo || new Date().toISOString().slice(0, 10));
      setPhone(party.phone || party.phone2 || '');
    }
  }, [open, initialFrom, initialTo, party]);

  // Date window only - NOT the page's kind tab. The statement PDF has to carry
  // every voucher for the period or its opening balance won't reconcile to its
  // closing figure, so the preview is scoped the same way as what actually goes.
  const periodTxns = useMemo(() => {
    let t = transactions;
    if (fromDate) t = t.filter((x) => x.date >= fromDate);
    if (toDate) t = t.filter((x) => x.date <= toDate + 'T23:59:59');
    return t;
  }, [transactions, fromDate, toDate]);

  const opening = periodTxns.length ? periodTxns[0].runningBalance - periodTxns[0].debit + periodTxns[0].credit : 0;
  const closing = periodTxns.length ? periodTxns[periodTxns.length - 1].runningBalance : (summary.balanceType === 'DR' ? summary.balance : -summary.balance);
  const totalDebit = periodTxns.reduce((s, x) => s + x.debit, 0);
  const totalCredit = periodTxns.reduce((s, x) => s + x.credit, 0);

  const handleSendApi = async () => {
    if (!phone.trim()) {
      toast.error('Please enter a valid phone number');
      return;
    }
    setLoading(true);
    try {
      const res = await api<{ ok: boolean; message: string; summaryText: string; transactionCount: number }>(
        `/whatsapp/parties/${party.id}/send-ledger`,
        {
          method: 'POST',
          body: { fromDate, toDate, phone: phone.trim() },
        }
      );
      if (!res.ok) {
        // Nothing went out - keep the dialog open so WhatsApp Web is one click away.
        toast.error(res.message || 'WhatsApp send failed');
        return;
      }
      toast.success(res.message || 'Party ledger statement sent!');
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to send WhatsApp message');
    } finally {
      setLoading(false);
    }
  };

  const handleOpenWhatsAppWeb = () => {
    const rawNumber = phone.trim() || party.phone || party.phone2 || '';
    let num = rawNumber.replace(/\D/g, '');
    if (num.length === 10) num = `91${num}`;

    const fromStr = fromDate || (periodTxns.length ? periodTxns[0].date.slice(0, 10) : 'Start');
    const toStr = toDate || (periodTxns.length ? periodTxns[periodTxns.length - 1].date.slice(0, 10) : 'Today');

    const msg = `*ACCOUNT STATEMENT - ${party.name.toUpperCase()}*\nPeriod: ${fromStr} to ${toStr}\nOpening Bal: ₹${Math.abs(opening).toLocaleString('en-IN')} ${opening >= 0 ? 'Dr' : 'Cr'}\nTotal Debits: ₹${totalDebit.toLocaleString('en-IN')}\nTotal Credits: ₹${totalCredit.toLocaleString('en-IN')}\n*Closing Bal: ₹${Math.abs(closing).toLocaleString('en-IN')} ${closing >= 0 ? 'Dr' : 'Cr'}*\n\nThank you,\n*${company?.name || 'RVP INDUSTRIES'}*`;

    window.open(`https://wa.me/${num}?text=${encodeURIComponent(msg)}`, '_blank');
  };

  const handleOpenPdf = () => {
    openPartyStatement({
      company,
      party,
      summary,
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
            Send Party Ledger via WhatsApp
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="rounded-lg border bg-muted/30 p-3 space-y-1">
            <div className="font-semibold text-sm">{party.name}</div>
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

          {/* Statement Summary Preview */}
          <div className="rounded-lg border bg-emerald-500/5 p-3 space-y-2 text-xs">
            <div className="font-semibold text-emerald-700 dark:text-emerald-400 uppercase tracking-wider text-[11px]">
              Statement Summary ({periodTxns.length} transactions)
            </div>
            <div className="grid grid-cols-2 gap-2 text-muted-foreground">
              <div>Opening: <span className="font-medium text-foreground">₹{Math.abs(opening).toLocaleString('en-IN')} {opening >= 0 ? 'Dr' : 'Cr'}</span></div>
              <div>Closing: <span className="font-bold text-foreground">₹{Math.abs(closing).toLocaleString('en-IN')} {closing >= 0 ? 'Dr' : 'Cr'}</span></div>
              <div>Debits: <span className="font-medium text-foreground">₹{totalDebit.toLocaleString('en-IN')}</span></div>
              <div>Credits: <span className="font-medium text-foreground">₹{totalCredit.toLocaleString('en-IN')}</span></div>
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
              Attaches the full statement for this period as a PDF - all transaction
              types, so the opening and closing balances reconcile.
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
