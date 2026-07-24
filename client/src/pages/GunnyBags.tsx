import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ReceiptText, Plus, Loader2, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { rupees, shortDate } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
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
  direction: 'PURCHASE' | 'SALE';
  quantity: number;
  amount: string;
  note: string | null;
}

// A ledger row = a GunnyBagEntry plus the running balance after it. Every entry
// auto-posts a full linked Payment/Receipt at record time (see poolReport.controller
// createGunnyBag), so "Paid" always equals the entry amount — there is no
// on-credit state to track. Balance is the running net cost (purchases − sales)
// still carried on Feroz's account.
interface LedgerRow extends GunnyBagEntry {
  balance: number;
}

const FEROZ_LEDGER_COLUMNS: ExportColumn<LedgerRow>[] = [
  { header: 'Date', value: (r) => shortDate(r.date) },
  { header: 'Type', value: (r) => (r.direction === 'PURCHASE' ? 'Purchase' : 'Sale') },
  { header: 'Bags', value: (r) => r.quantity, numFmt: '#,##0', align: 'right' },
  { header: 'Purchase Amount', value: (r) => (r.direction === 'PURCHASE' ? rupees(r.amount) : ''), excel: (r) => (r.direction === 'PURCHASE' ? Number(r.amount) : 0), numFmt: '#,##0.00', align: 'right' },
  { header: 'Sale Amount', value: (r) => (r.direction === 'SALE' ? rupees(r.amount) : ''), excel: (r) => (r.direction === 'SALE' ? Number(r.amount) : 0), numFmt: '#,##0.00', align: 'right' },
  { header: 'Paid', value: (r) => rupees(r.amount), excel: (r) => Number(r.amount), numFmt: '#,##0.00', align: 'right' },
  { header: 'Balance', value: (r) => rupees(r.balance), excel: (r) => r.balance, numFmt: '#,##0.00', align: 'right' },
  { header: 'Note', value: (r) => r.note ?? '' },
];

const today = () => new Date().toISOString().slice(0, 10);

export default function GunnyBags({ embedded = false }: { embedded?: boolean } = {}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ date: today(), direction: 'PURCHASE', quantity: '', amount: '', note: '' });

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
      setForm({ date: today(), direction: 'PURCHASE', quantity: '', amount: '', note: '' });
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
    const quantity = parseInt(form.quantity, 10);
    const amount = parseFloat(form.amount);
    if (!form.date || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(amount) || amount < 0) {
      toast.error('Enter a valid date, quantity and amount');
      return;
    }
    createMutation.mutate({ date: form.date, direction: form.direction, quantity, amount, note: form.note || null });
  }

  const purchased = rows.filter((r) => r.direction === 'PURCHASE');
  const sold = rows.filter((r) => r.direction === 'SALE');
  const totalPurchased = purchased.reduce((s, r) => s + Number(r.amount), 0);
  const totalSold = sold.reduce((s, r) => s + Number(r.amount), 0);
  const netCost = totalPurchased - totalSold;

  // Account-statement style: oldest first, running balance carried forward.
  const ledgerRows: LedgerRow[] = useMemo(() => {
    const asc = [...rows].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    let running = 0;
    return asc.map((r) => {
      running += r.direction === 'PURCHASE' ? Number(r.amount) : -Number(r.amount);
      return { ...r, balance: Math.round(running * 100) / 100 };
    });
  }, [rows]);
  const ledgerRowsDesc = [...ledgerRows].reverse();

  const actions = (
    <>
      <ExportButtons filename="Feroz_Ledger" title="Feroz Ledger — Gunny Bags" subtitle={`${rows.length} entry(s)`} columns={FEROZ_LEDGER_COLUMNS} rows={ledgerRowsDesc} />
      <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4 mr-1.5" /> Record</Button>
    </>
  );

  return (
    <div className="space-y-7">
      {embedded ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">Bardana bag purchases &amp; sales — Feroz's account. Net cost (purchases − sales) is deducted from the husk recovery pool; sales are booked as Gunny Bag Sales income.</p>
          <div className="flex items-center gap-2">{actions}</div>
        </div>
      ) : (
        <PageHeader
          icon={ReceiptText}
          title="Feroz Ledger"
          description="Bardana bag purchases & sales — Feroz's account. Net cost (purchases − sales) is deducted from the husk recovery pool; sales are booked as Gunny Bag Sales income."
          actions={actions}
        />
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Bags purchased" value={rupees(totalPurchased)} icon={ReceiptText} tone="clay" hint={`${purchased.reduce((s, r) => s + r.quantity, 0)} bags`} />
        <StatCard label="Bags sold" value={rupees(totalSold)} icon={ReceiptText} tone="forest" hint={`${sold.reduce((s, r) => s + r.quantity, 0)} bags`} />
        <StatCard label="Net balance (to husk pool)" value={rupees(netCost)} icon={ReceiptText} tone="amber" hint="purchases − sales" />
      </div>

      <div className="rounded-lg border bg-card overflow-auto">
        <div className="px-5 py-4 border-b font-semibold text-sm">Account Statement — Feroz (Gunny Bags)</div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Bags</TableHead>
              <TableHead className="text-right">Purchase Amount</TableHead>
              <TableHead className="text-right">Sale Amount</TableHead>
              <TableHead className="text-right">Paid</TableHead>
              <TableHead className="text-right">Balance</TableHead>
              <TableHead>Note</TableHead>
              <TableHead className="text-center">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={9} className="text-center py-8"><Loader2 className="h-6 w-6 animate-spin text-primary inline" /></TableCell></TableRow>
            ) : ledgerRowsDesc.length === 0 ? (
              <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-8">No gunny bag entries yet.</TableCell></TableRow>
            ) : ledgerRowsDesc.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{shortDate(r.date)}</TableCell>
                <TableCell>
                  <span className={`font-semibold ${r.direction === 'PURCHASE' ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                    {r.direction === 'PURCHASE' ? 'Purchase' : 'Sale'}
                  </span>
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">{r.quantity.toLocaleString('en-IN')}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{r.direction === 'PURCHASE' ? rupees(r.amount) : <span className="text-muted-foreground/50">-</span>}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{r.direction === 'SALE' ? rupees(r.amount) : <span className="text-muted-foreground/50">-</span>}</TableCell>
                <TableCell className={`text-right font-mono tabular-nums ${r.direction === 'PURCHASE' ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                  {rupees(r.amount)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums font-semibold">
                  {rupees(Math.abs(r.balance))} <span className="text-[9px] font-bold text-muted-foreground">{r.balance >= 0 ? 'DR' : 'CR'}</span>
                </TableCell>
                <TableCell className="text-muted-foreground">{r.note ?? '-'}</TableCell>
                <TableCell className="text-center">
                  <Button size="icon" variant="ghost" onClick={() => deleteMutation.mutate(r.id)} disabled={deleteMutation.isPending}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Record Gunny Bags</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label>Date</Label>
              <Input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>Type</Label>
              <Select value={form.direction} onValueChange={(v) => setForm((f) => ({ ...f, direction: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="PURCHASE">Purchase (bags bought)</SelectItem>
                  <SelectItem value="SALE">Sale (bags sold)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Number of bags</Label>
              <Input type="number" value={form.quantity} onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>Total amount (₹)</Label>
              <Input type="number" step="0.01" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} />
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
