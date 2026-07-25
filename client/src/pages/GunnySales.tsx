import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { PackageCheck, Plus, Loader2, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { rupees, shortDate } from '@/lib/format';
import { StatCard } from '@/components/StatCard';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';

interface GunnySaleEntry {
  id: string;
  date: string;
  bags: number;
  price: number;
  amount: number;
  note: string | null;
}

const GUNNY_SALES_COLUMNS: ExportColumn<GunnySaleEntry>[] = [
  { header: 'Date', value: (r) => shortDate(r.date) },
  { header: 'Bags', value: (r) => r.bags?.toLocaleString('en-IN') ?? '', numFmt: '#,##0', align: 'right' },
  { header: 'Price / Bag', value: (r) => rupees(r.price), excel: (r) => Number(r.price), numFmt: '#,##0.00', align: 'right' },
  { header: 'Amount', value: (r) => rupees(r.amount), excel: (r) => Number(r.amount), numFmt: '#,##0.00', align: 'right' },
  { header: 'Note', value: (r) => r.note ?? '' },
];

const today = () => new Date().toISOString().slice(0, 10);

export default function GunnySales() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ date: today(), bags: '', price: '', amount: '', note: '' });
  const [autoAmount, setAutoAmount] = useState(true);

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['gunny-sales'],
    queryFn: () => api<GunnySaleEntry[]>('/gunny-sales'),
  });

  const createMutation = useMutation({
    mutationFn: (body: any) => api('/gunny-sales', { method: 'POST', body }),
    onSuccess: () => {
      toast.success('Gunny sale recorded');
      qc.invalidateQueries({ queryKey: ['gunny-sales'] });
      qc.invalidateQueries({ queryKey: ['husk-pnl'] });
      qc.invalidateQueries({ queryKey: ['profit-loss'] });
      qc.invalidateQueries({ queryKey: ['receipts'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['journal-entries'] });
      setOpen(false);
      setForm({ date: today(), bags: '', price: '', amount: '', note: '' });
      setAutoAmount(true);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/gunny-sales/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Gunny sale deleted');
      qc.invalidateQueries({ queryKey: ['gunny-sales'] });
      qc.invalidateQueries({ queryKey: ['husk-pnl'] });
      qc.invalidateQueries({ queryKey: ['profit-loss'] });
      qc.invalidateQueries({ queryKey: ['receipts'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['journal-entries'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Auto-calculate amount = bags * price when bags or price changes
  const handleBagsChange = (val: string) => {
    const nextBags = val;
    const b = parseInt(nextBags, 10);
    const p = parseFloat(form.price);
    const calculated = !isNaN(b) && !isNaN(p) && b > 0 && p > 0 ? (b * p).toFixed(2) : form.amount;
    setForm((f) => ({
      ...f,
      bags: nextBags,
      amount: autoAmount && !isNaN(b) && !isNaN(p) && b > 0 && p > 0 ? calculated : f.amount,
    }));
  };

  const handlePriceChange = (val: string) => {
    const nextPrice = val;
    const b = parseInt(form.bags, 10);
    const p = parseFloat(nextPrice);
    const calculated = !isNaN(b) && !isNaN(p) && b > 0 && p > 0 ? (b * p).toFixed(2) : form.amount;
    setForm((f) => ({
      ...f,
      price: nextPrice,
      amount: autoAmount && !isNaN(b) && !isNaN(p) && b > 0 && p > 0 ? calculated : f.amount,
    }));
  };

  function submit() {
    const bags = parseInt(form.bags, 10);
    const price = parseFloat(form.price);
    const amount = parseFloat(form.amount);

    if (!form.date || isNaN(bags) || bags <= 0 || isNaN(price) || price <= 0 || isNaN(amount) || amount <= 0) {
      toast.error('Please enter a valid date, number of bags, price, and amount');
      return;
    }
    createMutation.mutate({
      date: form.date,
      bags,
      price,
      amount,
      note: form.note.trim() || null,
    });
  }

  const sortedRows = [...rows].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const totalAmount = sortedRows.reduce((s, r) => s + Number(r.amount), 0);
  const totalBags = sortedRows.reduce((s, r) => s + Number(r.bags || 0), 0);

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Record separate Gunny Bag sales income — each entry posts a linked Receipt to accounting. (For Feroz's account, see{' '}
          <Link to="/reports/gunny-bags" className="underline underline-offset-2 hover:text-foreground">Feroz Ledger</Link> in Expenses).
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Record Gunny Sale
          </Button>
          <ExportButtons filename="Gunny_Sales" title="Gunny Bag Sales" subtitle={`${sortedRows.length} entry(s)`} columns={GUNNY_SALES_COLUMNS} rows={sortedRows} />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Gunny Sales Income" value={rupees(totalAmount)} icon={PackageCheck} tone="forest" hint="total sales revenue" />
        <StatCard label="Total Bags Sold" value={totalBags.toLocaleString('en-IN')} icon={PackageCheck} tone="ocean" hint="bags" />
        <StatCard label="Total Entries" value={sortedRows.length} icon={PackageCheck} tone="amber" hint="sale transactions" />
      </div>

      <div className="rounded-lg border bg-card overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead className="text-right">Bags</TableHead>
              <TableHead className="text-right">Price / Bag</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Note</TableHead>
              <TableHead className="w-12"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6} className="text-center py-8"><Loader2 className="h-6 w-6 animate-spin text-primary inline" /></TableCell></TableRow>
            ) : sortedRows.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No gunny bag sales recorded yet.</TableCell></TableRow>
            ) : sortedRows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{shortDate(r.date)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{r.bags?.toLocaleString('en-IN') ?? '-'}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{rupees(r.price)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums text-emerald-600 dark:text-emerald-400 font-semibold">{rupees(r.amount)}</TableCell>
                <TableCell className="text-muted-foreground">{r.note ?? '-'}</TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    onClick={() => {
                      if (confirm('Delete this gunny sale entry? The linked accounting receipt will also be removed.')) {
                        deleteMutation.mutate(r.id);
                      }
                    }}
                    disabled={deleteMutation.isPending}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Record Gunny Sale</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="date">Date</Label>
              <Input id="date" type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="bags">Bags (Qty)</Label>
                <Input
                  id="bags"
                  type="number"
                  min="1"
                  step="1"
                  placeholder="e.g. 100"
                  value={form.bags}
                  onChange={(e) => handleBagsChange(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="price">Price / Bag (₹)</Label>
                <Input
                  id="price"
                  type="number"
                  min="0.01"
                  step="0.5"
                  placeholder="e.g. 45"
                  value={form.price}
                  onChange={(e) => handlePriceChange(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="amount">Total Amount (₹)</Label>
              <Input
                id="amount"
                type="number"
                min="0.01"
                step="0.01"
                placeholder="Total amount"
                value={form.amount}
                onChange={(e) => {
                  setAutoAmount(false);
                  setForm((f) => ({ ...f, amount: e.target.value }));
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="note">Note / Remarks (Optional)</Label>
              <Input id="note" placeholder="e.g. Buyer name, payment mode" value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={createMutation.isPending}>
              {createMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Record Sale
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
