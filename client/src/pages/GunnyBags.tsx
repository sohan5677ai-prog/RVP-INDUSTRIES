import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ReceiptText, Plus, Loader2, Trash2, Printer } from 'lucide-react';
import { api } from '@/lib/api';
import { rupees, shortDate } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';

interface GunnyBagEntry {
  id: string;
  date: string;
  type: 'PURCHASE' | 'SALE' | 'PAYMENT';
  quantity: number | null;
  debit: number;
  credit: number;
  payment: number;
  note: string | null;
}

interface LedgerRow extends GunnyBagEntry {
  particulars: string;
  subtext: string;
  reference: string;
  debitAmount: number;
  creditAmount: number;
  runningBalance: number;
}

const KIND_META: Record<string, { label: string; cls: string }> = {
  PURCHASE: { label: 'Purchase', cls: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20' },
  SALE: { label: 'Sale', cls: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20' },
  PAYMENT: { label: 'Payment', cls: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20' },
};

const FEROZ_LEDGER_COLUMNS: ExportColumn<LedgerRow>[] = [
  { header: 'Date', value: (r) => shortDate(r.date) },
  { header: 'Type', value: (r) => ({ PURCHASE: 'Purchase', SALE: 'Sale', PAYMENT: 'Payment' }[r.type]) },
  { header: 'Particulars', value: (r) => r.particulars + (r.subtext ? ` (${r.subtext})` : '') },
  { header: 'Reference', value: (r) => r.reference },
  { header: 'Debit', value: (r) => (r.debitAmount ? rupees(r.debitAmount) : ''), excel: (r) => r.debitAmount || 0, numFmt: '#,##0.00', align: 'right' },
  { header: 'Credit', value: (r) => (r.creditAmount ? rupees(r.creditAmount) : ''), excel: (r) => r.creditAmount || 0, numFmt: '#,##0.00', align: 'right' },
  { header: 'Balance', value: (r) => (r.runningBalance === 0 ? '0.00' : `${rupees(Math.abs(r.runningBalance))} ${r.runningBalance > 0 ? 'CR' : 'DR'}`), excel: (r) => r.runningBalance, numFmt: '#,##0.00', align: 'right' },
  { header: 'Note', value: (r) => r.note ?? '' },
];

const today = () => new Date().toISOString().slice(0, 10);

function BalanceCell({ value, muted }: { value: number; muted?: boolean }) {
  if (value === 0) return <span className="text-muted-foreground tabular-nums">0.00</span>;
  const cr = value > 0;
  return (
    <span className={`inline-flex items-baseline gap-1.5 tabular-nums ${muted ? 'text-muted-foreground' : `font-semibold ${cr ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`}`}>
      {rupees(Math.abs(value))}
      <span className={`text-[9px] font-bold px-1 py-0.5 rounded leading-none ${cr ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400' : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'}`}>
        {cr ? 'CR' : 'DR'}
      </span>
    </span>
  );
}

function SummaryStat({ label, value, tone }: { label: string; value: string; tone?: 'emerald' | 'rose' }) {
  const toneCls = tone === 'emerald' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'rose' ? 'text-rose-600 dark:text-rose-400' : '';
  return (
    <div className="px-5 py-3.5 text-center">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-base font-bold tabular-nums mt-0.5 ${toneCls}`}>{value}</div>
    </div>
  );
}

export default function GunnyBags({ embedded = false }: { embedded?: boolean } = {}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ date: today(), type: 'PURCHASE' as 'PURCHASE' | 'SALE' | 'PAYMENT', quantity: '', amount: '', note: '' });

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['gunny-bags'],
    queryFn: () => api<GunnyBagEntry[]>('/gunny-bags'),
  });

  const createMutation = useMutation({
    mutationFn: (body: any) => api('/gunny-bags', { method: 'POST', body }),
    onSuccess: () => {
      toast.success('Gunny bag entry recorded');
      qc.invalidateQueries({ queryKey: ['gunny-bags'] });
      qc.invalidateQueries({ queryKey: ['husk-pnl'] });
      qc.invalidateQueries({ queryKey: ['profit-loss'] });
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['receipts'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['journal-entries'] });
      setOpen(false);
      setForm({ date: today(), type: 'PURCHASE', quantity: '', amount: '', note: '' });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/gunny-bags/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Entry deleted');
      qc.invalidateQueries({ queryKey: ['gunny-bags'] });
      qc.invalidateQueries({ queryKey: ['husk-pnl'] });
      qc.invalidateQueries({ queryKey: ['profit-loss'] });
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['receipts'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['journal-entries'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function submit() {
    const quantity = form.quantity ? parseInt(form.quantity, 10) : null;
    const amount = parseFloat(form.amount);
    if (!form.date || !Number.isFinite(amount) || amount < 0) {
      toast.error('Enter a valid date and amount');
      return;
    }
    if ((form.type === 'PURCHASE' || form.type === 'SALE') && (!quantity || quantity <= 0)) {
      toast.error('Enter a valid quantity for Purchase/Sale');
      return;
    }
    createMutation.mutate({ date: form.date, type: form.type, quantity, amount, note: form.note || null });
  }

  // Account-statement style (Party Ledger format): oldest first, running balance carried forward.
  // Supplier account: Credit = Purchase (what we owe Feroz increases, CR balance)
  //                   Debit  = Payment made / Sale (what we owe Feroz decreases)
  const ledgerRows: LedgerRow[] = useMemo(() => {
    const asc = [...rows].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    let running = 0;
    return asc.map((r) => {
      let debitAmount = 0;
      let creditAmount = 0;
      let particulars = '';
      let subtext = '';
      let reference = '';

      if (r.type === 'PURCHASE') {
        creditAmount = Number(r.debit || (r as any).amount || 0);
        particulars = 'Gunny bag purchase';
        const qty = r.quantity ? Number(r.quantity) : 0;
        const rate = qty && creditAmount ? creditAmount / qty : 0;
        subtext = qty ? `${qty.toLocaleString('en-IN')} bags${rate ? ` @ ₹${rate.toFixed(2)}/bag` : ''}` : '';
        reference = r.note ? r.note : qty ? `Bags: ${qty.toLocaleString('en-IN')}` : '-';
      } else if (r.type === 'PAYMENT') {
        debitAmount = Number(r.payment || r.debit || (r as any).amount || 0);
        particulars = 'Payment made';
        subtext = 'Payment to Feroz';
        reference = r.note || 'Payment';
      } else if (r.type === 'SALE') {
        debitAmount = Number(r.credit || (r as any).amount || 0);
        particulars = 'Gunny bag sale';
        const qty = r.quantity ? Number(r.quantity) : 0;
        subtext = qty ? `${qty.toLocaleString('en-IN')} bags` : '';
        reference = r.note ? r.note : qty ? `Bags: ${qty.toLocaleString('en-IN')}` : '-';
      }

      running += creditAmount - debitAmount;

      return {
        ...r,
        particulars,
        subtext,
        reference,
        debitAmount,
        creditAmount,
        runningBalance: Math.round(running * 100) / 100,
      };
    });
  }, [rows]);

  const totalDebit = ledgerRows.reduce((s, r) => s + r.debitAmount, 0);
  const totalCredit = ledgerRows.reduce((s, r) => s + r.creditAmount, 0);
  const closingBalance = ledgerRows.length ? ledgerRows[ledgerRows.length - 1].runningBalance : 0;

  const actions = (
    <>
      <ExportButtons filename="Feroz_Ledger" title="Feroz Ledger - Gunny Bags" subtitle={`${rows.length} entry(s)`} columns={FEROZ_LEDGER_COLUMNS} rows={ledgerRows} showPrint={false} />
      <Button variant="outline" size="sm" onClick={() => window.print()} className="gap-1.5"><Printer className="h-4 w-4" /> Print</Button>
      <Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4 mr-1.5" /> Record</Button>
    </>
  );

  return (
    <div className="space-y-7">
      {embedded ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">Bardana bag purchases &amp; sales - Feroz's account. Net cost (purchases − sales) is deducted from the husk recovery pool; sales are booked as Gunny Bag Sales income.</p>
          <div className="flex items-center gap-2">{actions}</div>
        </div>
      ) : (
        <PageHeader
          icon={ReceiptText}
          title="Feroz Ledger"
          description="Bardana bag purchases & sales - Feroz's account. Net cost (purchases − sales) is deducted from the husk recovery pool; sales are booked as Gunny Bag Sales income."
          actions={actions}
        />
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Total Purchases" value={rupees(totalCredit)} icon={ReceiptText} tone="clay" hint="Total bought (credit)" />
        <StatCard label="Total Payments" value={rupees(totalDebit)} icon={ReceiptText} tone="forest" hint="Total paid (debit)" />
        <StatCard
          label="Payable to Feroz"
          value={closingBalance === 0 ? 'Settled' : `${rupees(Math.abs(closingBalance))} ${closingBalance > 0 ? 'CR' : 'DR'}`}
          icon={ReceiptText}
          tone={closingBalance === 0 ? 'taupe' : closingBalance > 0 ? 'amber' : 'forest'}
          hint="Net balance"
        />
      </div>

      {/* Statement Table (Party Ledger format) */}
      <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
        {/* Statement header band */}
        <div className="px-5 py-4 border-b bg-gradient-to-r from-primary/[0.07] via-card to-card flex items-end justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2">
              <ReceiptText className="h-4 w-4 text-primary" />
              <span className="font-semibold tracking-tight">Account Statement</span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">Account Statement - Feroz (Gunny Bags)</p>
          </div>
          <div className="text-right">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Closing Balance</div>
            <div className={`text-lg font-bold tabular-nums ${closingBalance === 0 ? '' : closingBalance > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
              {closingBalance === 0 ? 'Settled' : <>{rupees(Math.abs(closingBalance))} <span className="text-xs font-semibold">{closingBalance > 0 ? 'CR' : 'DR'}</span></>}
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
                <TableHead className="text-center w-16 print:hidden">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={7} className="h-32 text-center py-8"><Loader2 className="h-6 w-6 animate-spin text-primary inline" /></TableCell></TableRow>
              ) : ledgerRows.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="h-28 text-center text-muted-foreground py-8">No gunny bag entries yet.</TableCell></TableRow>
              ) : (
                <>
                  {/* Opening Balance */}
                  <TableRow className="bg-muted/30 hover:bg-muted/30">
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{shortDate(ledgerRows[0].date)}</TableCell>
                    <TableCell className="text-xs font-medium text-muted-foreground italic" colSpan={2}>Opening Balance</TableCell>
                    <TableCell className="border-l border-border/60 bg-muted/20 text-right text-muted-foreground">-</TableCell>
                    <TableCell className="bg-muted/20 text-right text-muted-foreground">-</TableCell>
                    <TableCell className="text-right border-l border-border/60 bg-muted/20"><BalanceCell value={0} muted /></TableCell>
                    <TableCell className="print:hidden" />
                  </TableRow>

                  {/* Transactions */}
                  {ledgerRows.map((t, i) => {
                    const meta = KIND_META[t.type] || { label: t.type, cls: 'bg-muted text-muted-foreground' };
                    return (
                      <TableRow key={t.id} className={i % 2 === 1 ? 'bg-muted/[0.18]' : undefined}>
                        <TableCell className="align-top text-sm whitespace-nowrap text-muted-foreground">{shortDate(t.date)}</TableCell>
                        <TableCell className="align-top">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className={`text-[10px] font-semibold ${meta.cls}`}>{meta.label}</Badge>
                          </div>
                          <div className="text-[13px] font-medium text-foreground/90 mt-1 leading-snug">{t.particulars}</div>
                          {t.subtext && <div className="text-[11px] text-muted-foreground mt-0.5">{t.subtext}</div>}
                        </TableCell>
                        <TableCell className="align-top text-xs text-muted-foreground font-mono">{t.reference}</TableCell>
                        <TableCell className="align-top text-right tabular-nums border-l border-border/60 font-semibold">
                          {t.debitAmount > 0 ? rupees(t.debitAmount) : <span className="text-muted-foreground/50 font-normal">-</span>}
                        </TableCell>
                        <TableCell className="align-top text-right tabular-nums font-semibold">
                          {t.creditAmount > 0 ? rupees(t.creditAmount) : <span className="text-muted-foreground/50 font-normal">-</span>}
                        </TableCell>
                        <TableCell className="align-top text-right border-l border-border/60">
                          <BalanceCell value={t.runningBalance} />
                        </TableCell>
                        <TableCell className="align-top text-center print:hidden">
                          <Button size="icon" variant="ghost" onClick={() => deleteMutation.mutate(t.id)} disabled={deleteMutation.isPending} className="h-7 w-7">
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}

                  {/* Closing Balance */}
                  <TableRow className="bg-primary/[0.06] hover:bg-primary/[0.06] border-t-2 border-border">
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap font-medium">{shortDate(ledgerRows[ledgerRows.length - 1].date)}</TableCell>
                    <TableCell className="text-sm font-semibold" colSpan={2}>Closing Balance</TableCell>
                    <TableCell className="text-right border-l border-border/60 font-semibold tabular-nums">{totalDebit > 0 ? rupees(totalDebit) : ''}</TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">{totalCredit > 0 ? rupees(totalCredit) : ''}</TableCell>
                    <TableCell className="text-right border-l border-border/60"><BalanceCell value={closingBalance} /></TableCell>
                    <TableCell className="print:hidden" />
                  </TableRow>
                </>
              )}
            </TableBody>
          </Table>
        </div>

        {ledgerRows.length > 0 && (
          <div className="grid grid-cols-3 divide-x divide-border border-t bg-muted/20">
            <SummaryStat label="Total Debit" value={rupees(totalDebit)} />
            <SummaryStat label="Total Credit" value={rupees(totalCredit)} />
            <SummaryStat
              label="Net Balance"
              value={closingBalance === 0 ? 'Settled' : `${rupees(Math.abs(closingBalance))} ${closingBalance > 0 ? 'CR' : 'DR'}`}
              tone={closingBalance === 0 ? undefined : closingBalance > 0 ? 'rose' : 'emerald'}
            />
          </div>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Record Feroz Ledger Entry</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label>Date</Label>
              <Input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>Type</Label>
              <Select value={form.type} onValueChange={(v: any) => setForm((f) => ({ ...f, type: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="PURCHASE">Purchase (bags bought)</SelectItem>
                  <SelectItem value="SALE">Sale (bags sold)</SelectItem>
                  <SelectItem value="PAYMENT">Payment (cash paid to Feroz)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.type !== 'PAYMENT' && (
              <div className="space-y-1">
                <Label>Number of bags</Label>
                <Input type="number" value={form.quantity} onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))} />
              </div>
            )}
            <div className="space-y-1">
              <Label>Amount (₹)</Label>
              <Input
                type="number"
                step="0.01"
                value={form.amount}
                onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Note (optional)</Label>
              <Input value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={createMutation.isPending}>
              {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
