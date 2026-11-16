import { useMemo, useState } from 'react';
import { usePagedRows } from '@/lib/usePagedRows';
import { PaginationBar } from '@/components/ui/pagination-bar';
import { SearchInput } from '@/components/ui/search-input';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';
import type { Payment, Transport } from '@/lib/types';
import { rupees, shortDate } from '@/lib/format';
import { normalizeLorryNumber } from '@/lib/calc';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

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
  freight: number;
  hamali: number;
  kata: number;
  /** Retention held back on this trip (₹0 for agencies with no retention). */
  retention: number;
  otherDeductions: { label: string; amount: number }[];
  extraCosts: { label: string; amount: number }[];
}

/**
 * Running account for one transport agency.
 *
 * Single-owner fleets (Transport.payToOwner) are settled as one account: every
 * lorry belongs to the same person and the money goes to his one bank account,
 * so what he is owed can only be read off a running account, never off a
 * per-trip list. Each dispatch credits his gross freight; the hamali, kata,
 * retention and any other deduction taken off that trip debit it back; freight
 * payments made against his lorries debit the rest. The closing balance is what
 * is still owed to him (CR) - or, when overpaid, what he owes back (DR).
 */
type LedgerKind = 'Freight' | 'Hamali' | 'Kata' | 'Retention' | 'Deduction' | 'Extra Cost' | 'Payment';

interface LedgerEntry {
  id: string;
  date: string;
  particulars: string;
  reference: string | null;
  kind: LedgerKind;
  debit: number;
  credit: number;
  runningBalance: number;
}

const KIND_TONE: Record<LedgerKind, string> = {
  Freight: 'bg-primary/10 text-primary border-primary/20',
  Hamali: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
  Kata: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
  Retention: 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20',
  Deduction: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20',
  'Extra Cost': 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20',
  Payment: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
};

const KIND_ORDER: Record<LedgerKind, number> = {
  Freight: 0,
  Hamali: 1,
  Kata: 2,
  Retention: 3,
  Deduction: 4,
  'Extra Cost': 5,
  Payment: 6,
};

const round2 = (n: number) => Math.round(n * 100) / 100;

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
  const [search, setSearch] = useState('');

  const entries: LedgerEntry[] = useMemo(() => {
    // A freight payment is tagged with a lorry number, never with the agency,
    // so the agency's own trips are what tie its payments back to this ledger.
    const ownLorries = new Set(
      trips.map((t) => normalizeLorryNumber(t.lorryNumber)).filter((x) => x !== '')
    );

    const raw: Omit<LedgerEntry, 'runningBalance'>[] = [];

    for (const t of trips) {
      const lorry = t.lorryNumber ?? '-';
      const tail = `${t.invoice ? ` · ${t.invoice}` : ''}${t.destination ? ` → ${t.destination}` : ''}`;
      raw.push({
        id: `${t.id}-freight`,
        date: t.date,
        particulars: `Freight · Lorry ${lorry}${tail}`,
        reference: t.invoice,
        kind: 'Freight',
        debit: 0,
        credit: round2(t.freight),
      });
      if (t.hamali > 0) {
        raw.push({
          id: `${t.id}-hamali`,
          date: t.date,
          particulars: `Hamali (loading) · Lorry ${lorry}`,
          reference: t.invoice,
          kind: 'Hamali',
          debit: round2(t.hamali),
          credit: 0,
        });
      }
      if (t.kata > 0) {
        raw.push({
          id: `${t.id}-kata`,
          date: t.date,
          particulars: `Kata fee · Lorry ${lorry}`,
          reference: t.invoice,
          kind: 'Kata',
          debit: round2(t.kata),
          credit: 0,
        });
      }
      if (t.retention > 0) {
        raw.push({
          id: `${t.id}-retention`,
          date: t.date,
          particulars: `Freight retention held · Lorry ${lorry}`,
          reference: t.invoice,
          kind: 'Retention',
          debit: round2(t.retention),
          credit: 0,
        });
      }
      t.otherDeductions.forEach((d, i) => {
        raw.push({
          id: `${t.id}-ded-${i}`,
          date: t.date,
          particulars: `${d.label} · Lorry ${lorry}`,
          reference: t.invoice,
          kind: 'Deduction',
          debit: round2(d.amount),
          credit: 0,
        });
      });
      t.extraCosts.forEach((a, i) => {
        raw.push({
          id: `${t.id}-add-${i}`,
          date: t.date,
          particulars: `${a.label} (extra cost) · Lorry ${lorry}`,
          reference: t.invoice,
          kind: 'Extra Cost',
          debit: 0,
          credit: round2(a.amount),
        });
      });
    }

    for (const p of payments) {
      if (p.type !== 'TRANSPORTER' && p.type !== 'TRANSPORTER_INWARD' && p.type !== 'TRANSPORTER_OUTWARD') continue;
      const lorry = normalizeLorryNumber(p.lorryNumber);
      if (!lorry || !ownLorries.has(lorry)) continue;
      const day = new Date(p.date).toISOString().slice(0, 10);
      if (startDate && day < startDate) continue;
      if (endDate && day > endDate) continue;
      raw.push({
        id: `pay-${p.id}`,
        date: p.date,
        particulars: `Payment · Lorry ${p.lorryNumber}${p.reference ? ` · ${p.reference}` : ''}`,
        reference: p.reference ?? null,
        kind: 'Payment',
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
  }, [trips, payments, startDate, endDate]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) =>
        e.particulars.toLowerCase().includes(q) ||
        e.kind.toLowerCase().includes(q) ||
        (e.reference ?? '').toLowerCase().includes(q)
    );
  }, [entries, search]);

  const { page, setPage, pageSize, setPageSize, totalPages, total, pageRows: visible = [] } = usePagedRows(filtered, 50);

  const totalEarned = round2(entries.filter((e) => e.credit > 0).reduce((s, e) => s + e.credit, 0));
  const totalDeducted = round2(entries.filter((e) => e.kind !== 'Payment').reduce((s, e) => s + e.debit, 0));
  const totalPaid = round2(entries.filter((e) => e.kind === 'Payment').reduce((s, e) => s + e.debit, 0));
  const closing = entries.length ? entries[entries.length - 1].runningBalance : 0;
  const balanceLabel = `${rupees(Math.abs(closing))} ${closing > 0 ? 'DR' : 'CR'}`;

  const exportColumns: ExportColumn<LedgerEntry>[] = [
    { header: 'Date', value: (e) => shortDate(e.date) },
    { header: 'Particulars', value: (e) => e.particulars },
    { header: 'Type', value: (e) => e.kind },
    { header: 'Debit', value: (e) => (e.debit ? rupees(e.debit) : ''), excel: (e) => e.debit || null, numFmt: '#,##0.00', align: 'right' },
    { header: 'Credit', value: (e) => (e.credit ? rupees(e.credit) : ''), excel: (e) => e.credit || null, numFmt: '#,##0.00', align: 'right' },
    {
      header: 'Balance',
      value: (e) => `${rupees(Math.abs(e.runningBalance))} ${e.runningBalance > 0 ? 'DR' : 'CR'}`,
      align: 'right',
    },
  ];

  const subtitle = transport?.payToOwner
    ? `Single owner · paid to ${transport.contactPerson?.trim() || transport.name}${transport.phone ? ` (${transport.phone})` : ''}`
    : 'Trips, deductions and freight payments for this agency';

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="bg-card border shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Freight Earned</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">{rupees(totalEarned)}</div>
            <p className="text-[10px] text-muted-foreground mt-1">Gross freight &amp; extra costs credited</p>
          </CardContent>
        </Card>
        <Card className="bg-card border shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Deductions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold text-amber-600 dark:text-amber-400">{rupees(totalDeducted)}</div>
            <p className="text-[10px] text-muted-foreground mt-1">Hamali, kata, retention &amp; other</p>
          </CardContent>
        </Card>
        <Card className="bg-card border shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Paid</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold text-emerald-600 dark:text-emerald-400">{rupees(totalPaid)}</div>
            <p className="text-[10px] text-muted-foreground mt-1">Freight payments against these lorries</p>
          </CardContent>
        </Card>
        <Card className="bg-card border shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Closing Balance</CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-xl font-bold ${closing > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
              {balanceLabel}
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">
              {closing > 0 ? 'Overpaid · recoverable' : 'Payable to the transport'}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="rounded-lg border bg-card">
        <div className="px-5 py-4 border-b flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-semibold text-sm">{transportName} Ledger</div>
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput
              value={search}
              onValueChange={setSearch}
              placeholder="Search lorry, invoice, entry…"
              className="h-9 w-56 bg-card"
            />
            <ExportButtons
              filename={`Ledger_${transportName.replace(/\s+/g, '_')}`}
              title={`${transportName} - Transport Ledger`}
              subtitle={`${entries.length} entries · closing ${balanceLabel}`}
              columns={exportColumns}
              rows={filtered}
            />
          </div>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-28">Date</TableHead>
              <TableHead className="min-w-[260px]">Particulars</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right border-l border-border/60 bg-secondary">Debit</TableHead>
              <TableHead className="text-right bg-secondary">Credit</TableHead>
              <TableHead className="text-right border-l border-border/60 bg-secondary">Balance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                  No ledger entries for {transportName} in the selected period.
                </TableCell>
              </TableRow>
            ) : (
              visible.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{shortDate(e.date)}</TableCell>
                  <TableCell className="text-sm">{e.particulars}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`text-[10px] ${KIND_TONE[e.kind]}`}>
                      {e.kind}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right text-sm border-l border-border/60">{e.debit ? rupees(e.debit) : '-'}</TableCell>
                  <TableCell className="text-right text-sm">{e.credit ? rupees(e.credit) : '-'}</TableCell>
                  <TableCell
                    className={`text-right text-sm font-semibold border-l border-border/60 ${
                      e.runningBalance > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
                    }`}
                  >
                    {rupees(Math.abs(e.runningBalance))} {e.runningBalance > 0 ? 'DR' : 'CR'}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        <PaginationBar page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalPages={totalPages} total={total} />
      </div>
    </div>
  );
}
