import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Zap, Plus, Loader2, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { rupees, shortDate } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';

interface ElectricityBill {
  id: string;
  date: string;
  month: string;
  units: number;
  amount: string;
  note: string | null;
}

const ELECTRICITY_COLUMNS: ExportColumn<ElectricityBill>[] = [
  { header: 'Date', value: (r) => shortDate(r.date) },
  { header: 'Month', value: (r) => r.month },
  { header: 'Units', value: (r) => r.units, numFmt: '#,##0', align: 'right' },
  { header: 'Bill Amount', value: (r) => rupees(r.amount), excel: (r) => Number(r.amount), numFmt: '#,##0.00', align: 'right' },
  { header: 'Note', value: (r) => r.note ?? '' },
];

const today = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => new Date().toISOString().slice(0, 7);

export default function Electricity({ embedded = false }: { embedded?: boolean } = {}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ date: today(), month: thisMonth(), units: '', amount: '', note: '' });

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['electricity-bills'],
    queryFn: () => api<ElectricityBill[]>('/electricity-bills'),
  });

  const createMutation = useMutation({
    mutationFn: (body: any) => api('/electricity-bills', { method: 'POST', body }),
    onSuccess: () => {
      toast.success('Electricity bill recorded');
      qc.invalidateQueries({ queryKey: ['electricity-bills'] });
      qc.invalidateQueries({ queryKey: ['husk-pnl'] });
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['journal-entries'] });
      setOpen(false);
      setForm({ date: today(), month: thisMonth(), units: '', amount: '', note: '' });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/electricity-bills/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Bill deleted');
      qc.invalidateQueries({ queryKey: ['electricity-bills'] });
      qc.invalidateQueries({ queryKey: ['husk-pnl'] });
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['journal-entries'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function submit() {
    const units = parseInt(form.units || '0', 10);
    const amount = parseFloat(form.amount);
    if (!form.date || !form.month || !Number.isFinite(amount) || amount < 0) {
      toast.error('Enter a valid date, month and bill amount');
      return;
    }
    createMutation.mutate({ date: form.date, month: form.month, units, amount, note: form.note || null });
  }

  const totalBill = rows.reduce((s, r) => s + Number(r.amount), 0);
  const totalUnits = rows.reduce((s, r) => s + r.units, 0);

  const actions = (
    <>
      <ExportButtons filename="Electricity_Bills" title="Electricity Bills" subtitle={`${rows.length} bill(s)`} columns={ELECTRICITY_COLUMNS} rows={rows} />
      <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4 mr-1.5" /> Record</Button>
    </>
  );

  return (
    <div className="space-y-7">
      {embedded ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">Monthly electricity bills. The total bill amount is deducted from the husk recovery pool.</p>
          <div className="flex items-center gap-2">{actions}</div>
        </div>
      ) : (
        <PageHeader
          icon={Zap}
          title="Electricity"
          description="Monthly electricity bills. The total bill amount is deducted from the husk recovery pool."
          actions={actions}
        />
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Total billed" value={rupees(totalBill)} icon={Zap} tone="amber" hint="to husk pool" />
        <StatCard label="Units consumed" value={totalUnits.toLocaleString('en-IN')} icon={Zap} tone="gold" hint="all months" />
        <StatCard label="Bills recorded" value={rows.length} icon={Zap} tone="forest" hint="entries" />
      </div>

      <div className="rounded-lg border bg-card overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Month</TableHead>
              <TableHead className="text-right">Units</TableHead>
              <TableHead className="text-right">Bill Amount</TableHead>
              <TableHead>Note</TableHead>
              <TableHead className="text-center">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6} className="text-center py-8"><Loader2 className="h-6 w-6 animate-spin text-primary inline" /></TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No electricity bills yet.</TableCell></TableRow>
            ) : rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{shortDate(r.date)}</TableCell>
                <TableCell className="font-medium">{r.month}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{r.units.toLocaleString('en-IN')}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{rupees(r.amount)}</TableCell>
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
          <DialogHeader><DialogTitle>Record Electricity Bill</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label>Date</Label>
              <Input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>Month</Label>
              <Input type="month" value={form.month} onChange={(e) => setForm((f) => ({ ...f, month: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>Units consumed</Label>
              <Input type="number" value={form.units} onChange={(e) => setForm((f) => ({ ...f, units: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>Total bill amount (₹)</Label>
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
