import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, getErrorMessage } from '@/lib/api';
import { invalidatePayments } from '@/lib/invalidatePayments';
import { usePagedRows } from '@/lib/usePagedRows';
import { PaginationBar } from '@/components/ui/pagination-bar';
import { ExportButtons } from '@/components/ExportButtons';
import { ScreenshotUpload, type ExtractedTransaction } from '@/components/ScreenshotUpload';
import type { ExportColumn } from '@/lib/export';
import type { Payment, Transport } from '@/lib/types';
import { rupees, shortDate } from '@/lib/format';
import { normalizeLorryNumber } from '@/lib/calc';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Search, Truck, Phone, MapPin, Hash, UserRound, ReceiptText,
  Scale, Wallet, TrendingDown, TrendingUp, Copy, Check, Loader2, Banknote,
} from 'lucide-react';

/**
 * One trip as the ledger needs it: what the agency earned on it and everything
 * taken off that freight. The Transport Report builds these from its dispatch
 * rows so the ledger agrees, rupee for rupee, with the Freight Dues page.
 */
export interface TransportLedgerTrip {
  id: string;
  date: string;
  lorryNumber: string | null;
  invoice: string | null;
  destination: string | null;
  buyer: string | null;
  weightKg: number;
  freight: number;
  hamali: number;
  kata: number;
  /** Retention held back on this trip (₹0 for agencies with no retention). */
  retention: number;
  otherDeductions: { label: string; amount: number }[];
  extraCosts: { label: string; amount: number }[];
}

/**
 * Running account for one transport agency, in the party ledger's shape.
 *
 * Single-owner fleets (Transport.payToOwner) are settled as one account: every
 * lorry belongs to the same person and the money goes to his one bank account,
 * so what he is owed can only be read off a running account, never off a
 * per-trip list. Each dispatch credits his gross freight; the hamali, kata,
 * retention and any other deduction taken off that trip debit it back; freight
 * payments made against his lorries debit the rest. The closing balance is what
 * is still owed to him (CR) - or, when overpaid, what he owes back (DR).
 */
type LedgerKind = 'FREIGHT' | 'HAMALI' | 'KATA' | 'RETENTION' | 'DEDUCTION' | 'EXTRA' | 'PAYMENT';

const KIND_META: Record<LedgerKind, { label: string; cls: string }> = {
  FREIGHT: { label: 'Freight', cls: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20' },
  HAMALI: { label: 'Hamali', cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20' },
  KATA: { label: 'Kata', cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20' },
  RETENTION: { label: 'Retention', cls: 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20' },
  DEDUCTION: { label: 'Deduction', cls: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20' },
  EXTRA: { label: 'Extra Cost', cls: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20' },
  PAYMENT: { label: 'Payment', cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20' },
};

const KIND_ORDER: Record<LedgerKind, number> = {
  FREIGHT: 0, HAMALI: 1, KATA: 2, RETENTION: 3, DEDUCTION: 4, EXTRA: 5, PAYMENT: 6,
};

const KIND_FILTERS: { label: string; value: 'ALL' | LedgerKind }[] = [
  { label: 'All', value: 'ALL' },
  { label: 'Freight', value: 'FREIGHT' },
  { label: 'Hamali', value: 'HAMALI' },
  { label: 'Kata', value: 'KATA' },
  { label: 'Deductions', value: 'DEDUCTION' },
  { label: 'Payments', value: 'PAYMENT' },
];

interface LedgerEntry {
  id: string;
  date: string;
  kind: LedgerKind;
  /** Main line, e.g. "Freight - Pappu to Coimbatore". */
  particulars: string;
  /** Grey detail under it, e.g. "24,290 kg · AB Traders". */
  detail: string | null;
  lorryNumber: string | null;
  invoiceNumber: string | null;
  utr: string | null;
  debit: number;
  credit: number;
  runningBalance: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function balanceColor(dr: boolean) {
  return dr ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400';
}

export function TransportLedger({
  trips,
  payments,
  transport,
  transportName,
  startDate,
  endDate,
}: {
  trips: TransportLedgerTrip[];
  payments: Payment[];
  transport: Transport | null;
  transportName: string;
  startDate: string;
  endDate: string;
}) {
  const [kind, setKind] = useState<'ALL' | LedgerKind>('ALL');
  const [q, setQ] = useState('');
  const qc = useQueryClient();
  // On-account settlement of the whole agency (see the Pay Agency dialog).
  const [payOpen, setPayOpen] = useState(false);
  const [payDate, setPayDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [payAmount, setPayAmount] = useState('');
  const [payReference, setPayReference] = useState('');
  // Proof of payment. Its presence is what decides the WhatsApp template the
  // owner receives: PAYMENT_SENT carries the image, PAYMENT_SENT_TEXT does not.
  const [payScreenshot, setPayScreenshot] = useState<File | null>(null);
  // Remounts the drop zone on each open so a previous file's preview is gone.
  const [payFormKey, setPayFormKey] = useState(0);

  const entries: LedgerEntry[] = useMemo(() => {
    // A freight payment is tagged with a lorry number, never with the agency,
    // so the agency's own trips are what tie its payments back to this ledger.
    const ownLorries = new Set(
      trips.map((t) => normalizeLorryNumber(t.lorryNumber)).filter((x) => x !== '')
    );

    const raw: Omit<LedgerEntry, 'runningBalance'>[] = [];

    for (const t of trips) {
      const base = {
        date: t.date,
        lorryNumber: t.lorryNumber,
        invoiceNumber: t.invoice,
        utr: null as string | null,
      };
      const tripDetail = [
        t.weightKg ? `${t.weightKg.toLocaleString('en-IN')} kg` : null,
        t.buyer,
      ].filter(Boolean).join(' · ') || null;

      raw.push({
        ...base,
        id: `${t.id}-freight`,
        kind: 'FREIGHT',
        particulars: t.destination ? `Freight - ${t.destination}` : 'Freight',
        detail: tripDetail,
        debit: 0,
        credit: round2(t.freight),
      });
      if (t.hamali > 0) {
        raw.push({
          ...base,
          id: `${t.id}-hamali`,
          kind: 'HAMALI',
          particulars: 'Hamali (loading) deducted',
          detail: "Lorry's share of the loading hamali",
          debit: round2(t.hamali),
          credit: 0,
        });
      }
      if (t.kata > 0) {
        raw.push({
          ...base,
          id: `${t.id}-kata`,
          kind: 'KATA',
          particulars: 'Kata fee deducted',
          detail: 'Weighbridge charge',
          debit: round2(t.kata),
          credit: 0,
        });
      }
      if (t.retention > 0) {
        raw.push({
          ...base,
          id: `${t.id}-retention`,
          kind: 'RETENTION',
          particulars: 'Freight retention held',
          detail: 'Released on delivery',
          debit: round2(t.retention),
          credit: 0,
        });
      }
      t.otherDeductions.forEach((d, i) => {
        raw.push({
          ...base,
          id: `${t.id}-ded-${i}`,
          kind: 'DEDUCTION',
          particulars: d.label,
          detail: 'Deducted off this trip',
          debit: round2(d.amount),
          credit: 0,
        });
      });
      t.extraCosts.forEach((a, i) => {
        raw.push({
          ...base,
          id: `${t.id}-add-${i}`,
          kind: 'EXTRA',
          particulars: a.label,
          detail: 'Extra cost allowed on this trip',
          debit: 0,
          credit: round2(a.amount),
        });
      });
    }

    for (const p of payments) {
      if (p.type !== 'TRANSPORTER' && p.type !== 'TRANSPORTER_INWARD' && p.type !== 'TRANSPORTER_OUTWARD') continue;
      // Either the payment names this agency (an on-account settlement, which
      // carries no lorry at all) or it names one of its lorries. The lorry
      // route is what every payment recorded before agency payments existed
      // still travels, so both have to answer here.
      const lorry = normalizeLorryNumber(p.lorryNumber);
      const isOwnAgency = Boolean(transport?.id && p.transportId === transport.id);
      if (!isOwnAgency && (!lorry || !ownLorries.has(lorry))) continue;
      const day = new Date(p.date).toISOString().slice(0, 10);
      if (startDate && day < startDate) continue;
      if (endDate && day > endDate) continue;
      raw.push({
        id: `pay-${p.id}`,
        date: p.date,
        kind: 'PAYMENT',
        particulars: isOwnAgency && !lorry ? 'Payment made - on account' : 'Payment made',
        detail: p.payee || p.description || null,
        lorryNumber: p.lorryNumber ?? null,
        invoiceNumber: null,
        utr: p.reference ?? null,
        debit: round2(Number(p.amount) || 0),
        credit: 0,
      });
    }

    raw.sort((a, b) => {
      const d = new Date(a.date).getTime() - new Date(b.date).getTime();
      if (d !== 0) return d;
      // Within a day: the trip's freight first, then what comes off it, then cash.
      return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    });

    let running = 0;
    return raw.map((e) => {
      running = round2(running + e.debit - e.credit);
      return { ...e, runningBalance: running };
    });
  }, [trips, payments, transport?.id, startDate, endDate]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return entries.filter((e) => {
      if (kind !== 'ALL' && e.kind !== kind) return false;
      if (!needle) return true;
      return (
        e.particulars.toLowerCase().includes(needle) ||
        (e.detail ?? '').toLowerCase().includes(needle) ||
        (e.lorryNumber ?? '').toLowerCase().includes(needle) ||
        (e.invoiceNumber ?? '').toLowerCase().includes(needle) ||
        (e.utr ?? '').toLowerCase().includes(needle)
      );
    });
  }, [entries, kind, q]);

  const { page, setPage, pageSize, setPageSize, totalPages, total, pageRows: paged = [] } = usePagedRows(filtered, 50);

  // The account's own position is read off every entry, not off the filtered
  // view - a ledger filtered to "Payments" still owes what it owes.
  const closing = entries.length ? entries[entries.length - 1].runningBalance : 0;
  const totalFreight = round2(entries.filter((e) => e.kind === 'FREIGHT').reduce((s, e) => s + e.credit, 0));
  const totalDeducted = round2(entries.filter((e) => e.kind !== 'PAYMENT').reduce((s, e) => s + e.debit, 0));
  const totalPaid = round2(entries.filter((e) => e.kind === 'PAYMENT').reduce((s, e) => s + e.debit, 0));
  const lifetime = round2(entries.reduce((s, e) => s + e.credit, 0));

  const viewDebit = round2(filtered.reduce((s, e) => s + e.debit, 0));
  const viewCredit = round2(filtered.reduce((s, e) => s + e.credit, 0));

  const periodText = entries.length
    ? `${shortDate(entries[0].date)} – ${shortDate(entries[entries.length - 1].date)}`
    : '';

  // What is still owed to the agency: a CR closing balance (negative here).
  const payableNow = closing < 0 ? round2(-closing) : 0;

  const payMutation = useMutation({
    mutationFn: () => {
      if (!transport?.id) throw new Error('No transport agency selected');
      const fields = {
        date: payDate,
        amount: Number(payAmount) || 0,
        // Outward freight is what an agency ledger is built from, and the
        // same 20250 payable is what an on-account payment settles.
        type: 'TRANSPORTER_OUTWARD',
        transportId: transport.id,
        payee: transportName,
        reference: payReference || null,
        description: `Freight payment on account - ${transportName}`,
      };
      // With a proof screenshot the create goes multipart, the same way the
      // Payments register does it: the server stores the file and WhatsApps it
      // to the owner on the image template. Plain JSON otherwise.
      if (payScreenshot) {
        const fd = new FormData();
        for (const [k, v] of Object.entries(fields)) {
          if (v !== null && v !== undefined) fd.append(k, String(v));
        }
        fd.append('screenshot', payScreenshot);
        return api<Payment>('/payments', { method: 'POST', body: fd, multipart: true });
      }
      return api<Payment>('/payments', { method: 'POST', body: fields });
    },
    onSuccess: () => {
      void invalidatePayments(qc);
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['journal-entries'] });
      toast.success(
        payScreenshot
          ? 'Agency payment recorded - receipt sent with the screenshot'
          : 'Agency payment recorded'
      );
      setPayOpen(false);
      setPayAmount('');
      setPayReference('');
      setPayScreenshot(null);
      setPayFormKey((k) => k + 1);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  // The OCR read off the screenshot. Only the amount and the reference are
  // taken: the counterparty is already known (this is the agency's own ledger),
  // and the date stays the value date the user picked.
  const applyExtracted = (d: ExtractedTransaction) => {
    if (d.amount && d.amount > 0) setPayAmount(String(Math.round(d.amount)));
    if (d.reference) setPayReference(d.reference);
    if (d.date) setPayDate(d.date);
  };

  const openPayDialog = () => {
    // Prefilled with the whole outstanding balance, which is what a settlement
    // usually is - overtypeable for a part payment or an advance.
    setPayAmount(payableNow > 0 ? String(payableNow) : '');
    setPayReference('');
    setPayDate(new Date().toISOString().slice(0, 10));
    setPayScreenshot(null);
    setPayFormKey((k) => k + 1);
    setPayOpen(true);
  };

  const ownerName = transport?.contactPerson?.trim() || '';
  const phones = [transport?.phone, transport?.phone2].map((p) => (p || '').trim()).filter(Boolean);
  // Who is told about this agency's money: one row per number on file, each
  // under its own person's name. An agency is often two people - a manager and
  // the owner - and both get every message, so both belong on this card.
  const contacts = [
    { name: transport?.contactPerson?.trim() || '', phone: (transport?.phone || '').trim() },
    { name: transport?.contactPerson2?.trim() || '', phone: (transport?.phone2 || '').trim() },
  ].filter((c) => c.phone);
  const address = [transport?.address, transport?.city, transport?.state].map((p) => (p || '').trim()).filter(Boolean).join(', ');

  const exportColumns: ExportColumn<LedgerEntry>[] = [
    { header: 'Date', value: (e) => shortDate(e.date) },
    { header: 'Type', value: (e) => KIND_META[e.kind].label },
    { header: 'Particulars', value: (e) => e.particulars },
    { header: 'Lorry No', value: (e) => e.lorryNumber ?? '' },
    { header: 'Invoice No', value: (e) => e.invoiceNumber ?? '' },
    { header: 'UTR / Ref', value: (e) => e.utr ?? '' },
    { header: 'Debit', value: (e) => (e.debit ? rupees(e.debit) : ''), excel: (e) => e.debit || null, numFmt: '#,##0.00', align: 'right' },
    { header: 'Credit', value: (e) => (e.credit ? rupees(e.credit) : ''), excel: (e) => e.credit || null, numFmt: '#,##0.00', align: 'right' },
    {
      header: 'Balance',
      value: (e) => (e.runningBalance === 0 ? '0.00' : `${rupees(Math.abs(e.runningBalance))} ${e.runningBalance > 0 ? 'DR' : 'CR'}`),
      align: 'right',
    },
  ];

  return (
    <div className="space-y-6">
      {/* profile header */}
      <div className="rounded-xl border bg-gradient-to-br from-primary/5 via-card to-card overflow-hidden">
        <div className="p-6 flex flex-col lg:flex-row lg:items-start gap-6">
          <div className="flex items-start gap-4 flex-1">
            <div className="h-14 w-14 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <Truck className="h-7 w-7" />
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-2xl font-bold tracking-tight">{transportName}</h2>
                <Badge variant="outline" className="font-medium">
                  {transport?.payToOwner ? 'Single Owner' : 'Transport'}
                </Badge>
                {transport?.code && <Badge variant="outline" className="font-mono text-[10px]">{transport.code}</Badge>}
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-1.5 text-sm text-muted-foreground">
                {phones.length > 0 && (
                  <span className="inline-flex items-center gap-1.5">
                    <Phone className="h-3.5 w-3.5" /> {phones.join(' / ')}
                  </span>
                )}
                {ownerName && (
                  <span className="inline-flex items-center gap-1.5">
                    <UserRound className="h-3.5 w-3.5" /> {ownerName}
                  </span>
                )}
                {address && (
                  <span className="inline-flex items-center gap-1.5">
                    <MapPin className="h-3.5 w-3.5" /> {address}
                  </span>
                )}
                {transport?.gstin && (
                  <span className="inline-flex items-center gap-1.5 group font-medium tracking-wide">
                    <Hash className="h-3.5 w-3.5" /> {transport.gstin} <CopyBtn value={transport.gstin} />
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* who the money goes to */}
          <div className="lg:w-80 shrink-0 rounded-lg border bg-background/60 p-4 space-y-2.5">
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <Wallet className="h-3.5 w-3.5" /> Payee
            </div>
            {transport?.payToOwner ? (
              <div className="space-y-1.5 text-sm">
                {contacts.length > 0 ? (
                  contacts.map((c, i) => (
                    <Info
                      key={c.phone}
                      label={c.name || (i === 0 ? 'Contact' : 'Second contact')}
                      value={c.phone}
                      mono
                      copy
                    />
                  ))
                ) : (
                  <p className="text-xs text-muted-foreground italic">No number on file yet.</p>
                )}
                <p className="text-[11px] text-muted-foreground leading-snug pt-1 border-t">
                  Every lorry is settled on this one account.{' '}
                  {contacts.length > 1
                    ? 'Both contacts get every receipt - never the driver.'
                    : 'Freight receipts go to this contact, never the driver.'}
                </p>
                <Button size="sm" className="w-full mt-1" onClick={openPayDialog} disabled={!transport?.id}>
                  <Banknote className="h-4 w-4 mr-1.5" />
                  Pay Agency
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground italic">
                Paid per lorry. Switch on "Single owner" in Master Data to settle this agency on one account.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          icon={closing > 0 ? TrendingUp : TrendingDown}
          label={closing > 0 ? 'Recoverable (overpaid)' : 'Payable (we owe)'}
          value={closing === 0 ? 'Settled' : rupees(Math.abs(closing))}
          sub={closing === 0 ? undefined : closing > 0 ? 'DR' : 'CR'}
          tone={closing === 0 ? 'neutral' : closing > 0 ? 'emerald' : 'rose'}
        />
        <KpiCard icon={Scale} label="Lifetime Freight" value={rupees(lifetime)} hint={`${entries.length} entries · ${trips.length} trips`} />
        <KpiCard icon={ReceiptText} label="Gross Freight" value={rupees(totalFreight)} tone="blue" hint={`${rupees(totalDeducted)} deducted`} />
        <KpiCard
          icon={Wallet}
          label="Total Paid"
          value={rupees(totalPaid)}
          hint={transport?.payToOwner ? 'On account and per lorry' : 'Freight payments on these lorries'}
        />
      </div>

      {/* filters */}
      <div className="flex flex-col lg:flex-row gap-3 print:hidden">
        <div className="inline-flex rounded-lg border bg-card p-1 self-start">
          {KIND_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => { setKind(f.value); setPage(1); }}
              className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors ${
                kind === f.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1); }}
            placeholder="Search lorry, invoice, UTR…"
            className="pl-9"
          />
        </div>
        <ExportButtons
          filename={`Ledger_${transportName.replace(/\s+/g, '_')}`}
          title={`${transportName} - Transport Ledger`}
          subtitle={periodText ? `${periodText} · ${filtered.length} entries` : `${filtered.length} entries`}
          columns={exportColumns}
          rows={filtered}
        />
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
              {periodText ? `${transportName} · ${periodText}` : transportName}
            </p>
          </div>
          <div className="text-right">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Closing Balance</div>
            <div className={`text-lg font-bold tabular-nums ${closing === 0 ? '' : balanceColor(closing > 0)}`}>
              {closing === 0 ? 'Settled' : <>{rupees(Math.abs(closing))} <span className="text-xs font-semibold">{closing > 0 ? 'DR' : 'CR'}</span></>}
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
                <TableRow>
                  <TableCell colSpan={6} className="h-28 text-center text-muted-foreground">
                    No entries for {transportName} with the selected filters.
                  </TableCell>
                </TableRow>
              ) : (
                <>
                  <TableRow className="bg-muted/30 hover:bg-muted/30">
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{shortDate(filtered[0].date)}</TableCell>
                    <TableCell className="text-xs font-medium text-muted-foreground italic" colSpan={2}>Opening Balance</TableCell>
                    <TableCell className="text-right border-l border-border/60 bg-muted/20" />
                    <TableCell className="text-right bg-muted/20" />
                    <TableCell className="text-right border-l border-border/60 bg-muted/20">
                      <BalanceCell value={0} muted />
                    </TableCell>
                  </TableRow>

                  {paged.map((e, i) => <EntryRow key={e.id} e={e} zebra={i % 2 === 1} />)}

                  <TableRow className="bg-primary/[0.06] hover:bg-primary/[0.06] border-t-2 border-border">
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap font-medium">
                      {shortDate(filtered[filtered.length - 1].date)}
                    </TableCell>
                    <TableCell className="text-sm font-semibold" colSpan={2}>Closing Balance</TableCell>
                    <TableCell className="text-right border-l border-border/60 font-semibold tabular-nums">{viewDebit > 0 ? rupees(viewDebit) : ''}</TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">{viewCredit > 0 ? rupees(viewCredit) : ''}</TableCell>
                    <TableCell className="text-right border-l border-border/60"><BalanceCell value={closing} /></TableCell>
                  </TableRow>
                </>
              )}
            </TableBody>
          </Table>
        </div>

        {filtered.length > 0 && (
          <div className="grid grid-cols-3 divide-x divide-border border-t bg-muted/20">
            <SummaryStat label="Total Debit" value={rupees(viewDebit)} />
            <SummaryStat label="Total Credit" value={rupees(viewCredit)} />
            <SummaryStat
              label="Net Balance"
              value={closing === 0 ? 'Settled' : `${rupees(Math.abs(closing))} ${closing > 0 ? 'DR' : 'CR'}`}
              tone={closing === 0 ? undefined : closing > 0 ? 'emerald' : 'rose'}
            />
          </div>
        )}
      </div>

      <PaginationBar page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalPages={totalPages} total={total} />

      {/* On-account settlement. Deliberately NOT allocated against particular
          trips: this is a running account, so one transfer simply debits the
          balance and the closing figure stays the answer to "what do we owe
          him". Guessing which trips a round figure covered would put a wrong
          paid date on real trips. */}
      <Dialog open={payOpen} onOpenChange={setPayOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pay {transportName}</DialogTitle>
            <DialogDescription>
              {payableNow > 0
                ? <>Outstanding on this account: <strong>{rupees(payableNow)}</strong>. The payment debits the account as a whole - no lorry is tagged.</>
                : <>Nothing outstanding on this account right now. A payment recorded here will sit as an advance.</>}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <ScreenshotUpload
              key={payFormKey}
              endpoint="/payments/extract"
              hint="Drop the bank / UPI screenshot to auto-fill"
              onExtracted={applyExtracted}
              onFile={setPayScreenshot}
            />

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="agency-pay-date">Date</Label>
                <Input
                  id="agency-pay-date"
                  type="date"
                  value={payDate}
                  onChange={(e) => setPayDate(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="agency-pay-amount">Amount (₹)</Label>
                <Input
                  id="agency-pay-amount"
                  type="number"
                  inputMode="numeric"
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                  placeholder="0"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="agency-pay-ref">UTR / Reference</Label>
              <Input
                id="agency-pay-ref"
                value={payReference}
                onChange={(e) => setPayReference(e.target.value)}
                placeholder="Bank reference number"
              />
            </div>

            {payableNow > 0 && Number(payAmount) > payableNow && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                This is more than the {rupees(payableNow)} outstanding - the extra will stand as an advance against future trips.
              </p>
            )}

            <p className="text-[11px] text-muted-foreground leading-snug">
              {contacts.length > 0 ? (
                <>
                  A WhatsApp receipt goes to{' '}
                  {contacts.map((c, i) => (
                    <span key={c.phone}>
                      {i > 0 && (i === contacts.length - 1 ? ' and ' : ', ')}
                      <strong>{c.name || transportName}</strong> ({c.phone})
                    </span>
                  ))}
                  {payScreenshot
                    ? ', with the screenshot attached'
                    : ' - attach a screenshot above to send it with the receipt'}
                  .
                </>
              ) : (
                <>
                  No WhatsApp number on file for{' '}
                  <strong>{ownerName || transportName}</strong>, so no receipt can be
                  sent. Add one in Master Data → Transports.
                </>
              )}
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setPayOpen(false)}>Cancel</Button>
            <Button
              onClick={() => payMutation.mutate()}
              disabled={payMutation.isPending || !(Number(payAmount) > 0)}
            >
              {payMutation.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Record Payment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* --------------------------------------------------------------- one row */

function EntryRow({ e, zebra }: { e: LedgerEntry; zebra?: boolean }) {
  const meta = KIND_META[e.kind];
  const refs = [
    e.invoiceNumber && { label: 'Inv', value: e.invoiceNumber },
    e.lorryNumber && { label: 'Veh', value: e.lorryNumber },
    e.utr && { label: 'UTR', value: e.utr },
  ].filter(Boolean) as { label: string; value: string }[];

  return (
    <TableRow className={zebra ? 'bg-muted/[0.18]' : undefined}>
      <TableCell className="align-top text-sm whitespace-nowrap text-muted-foreground">{shortDate(e.date)}</TableCell>
      <TableCell className="align-top">
        <Badge variant="outline" className={`text-[10px] font-semibold ${meta.cls}`}>{meta.label}</Badge>
        <div className="text-[13px] text-foreground/90 mt-1.5 leading-snug whitespace-normal">{e.particulars}</div>
        {e.detail && <div className="text-[11px] text-muted-foreground mt-0.5">{e.detail}</div>}
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
            <div className="flex items-baseline gap-1.5 text-[11px]">
              <span className="text-muted-foreground w-7 shrink-0">Dt</span>
              <span className="text-muted-foreground">{shortDate(e.date)}</span>
            </div>
          </div>
        ) : (
          <span className="text-muted-foreground text-xs">-</span>
        )}
      </TableCell>
      <TableCell className="align-top text-right tabular-nums border-l border-border/60">
        {e.debit > 0 ? <span className="font-semibold text-foreground">{rupees(e.debit)}</span> : <span className="text-muted-foreground/50">-</span>}
      </TableCell>
      <TableCell className="align-top text-right tabular-nums">
        {e.credit > 0 ? <span className="font-semibold text-foreground">{rupees(e.credit)}</span> : <span className="text-muted-foreground/50">-</span>}
      </TableCell>
      <TableCell className="align-top text-right border-l border-border/60">
        <BalanceCell value={e.runningBalance} />
      </TableCell>
    </TableRow>
  );
}

/* ------------------------------------------------------------ small bits */

function BalanceCell({ value, muted }: { value: number; muted?: boolean }) {
  if (value === 0) return <span className="text-muted-foreground tabular-nums">0.00</span>;
  const dr = value > 0;
  return (
    <span className={`inline-flex items-baseline gap-1.5 tabular-nums ${muted ? 'text-muted-foreground' : `font-semibold ${balanceColor(dr)}`}`}>
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
