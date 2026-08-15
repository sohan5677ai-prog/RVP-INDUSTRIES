import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { PiggyBank, Plus, Loader2, Trash2, Pencil } from 'lucide-react';
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
import type { OtherIncomeEntry } from '@/lib/types';

const OTHER_INCOME_COLUMNS: ExportColumn<OtherIncomeEntry>[] = [
  { header: 'Date', value: (r) => shortDate(r.date) },
  { header: 'Label', value: (r) => r.label },
  { header: 'Amount', value: (r) => rupees(r.amount), excel: (r) => Number(r.amount), numFmt: '#,##0.00', align: 'right' },
  { header: 'Note', value: (r) => r.note ?? '' },
];

const today = () => new Date().toISOString().slice(0, 10);

export default function OtherIncome({ embedded = false }: { embedded?: boolean } = {}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ date: today(), label: '', amount: '', note: '' });

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['other-income'],
    queryFn: () => api<OtherIncomeEntry[]>('/other-income'),
  });

  const createMutation = useMutation({
    mutationFn: (body: any) => api('/other-income', { method: 'POST', body }),
    onSuccess: () => {
      toast.success('Other income recorded');
      qc.invalidateQueries({ queryKey: ['other-income'] });
      qc.invalidateQueries({ queryKey: ['husk-pnl'] });
      qc.invalidateQueries({ queryKey: ['profit-loss'] });
      qc.invalidateQueries({ queryKey: ['receipts'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['journal-entries'] });
      setOpen(false);
      setForm({ date: today(), label: '', amount: '', note: '' });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: any }) => api(`/other-income/${id}`, { method: 'PUT', body }),
    onSuccess: () => {
      toast.success('Entry updated');
      qc.invalidateQueries({ queryKey: ['other-income'] });
      qc.invalidateQueries({ queryKey: ['husk-pnl'] });
      qc.invalidateQueries({ queryKey: ['profit-loss'] });
      qc.invalidateQueries({ queryKey: ['receipts'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['journal-entries'] });
      setOpen(false);
      setEditingId(null);
      setForm({ date: today(), label: '', amount: '', note: '' });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/other-income/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Entry deleted');
      qc.invalidateQueries({ queryKey: ['other-income'] });
      qc.invalidateQueries({ queryKey: ['husk-pnl'] });
      qc.invalidateQueries({ queryKey: ['profit-loss'] });
      qc.invalidateQueries({ queryKey: ['receipts'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['journal-entries'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function submit() {
    const amount = parseFloat(form.amount);
    if (!form.date || !form.label.trim() || !Number.isFinite(amount) || amount <= 0) {
      toast.error('Enter a valid date, label and amount');
      return;
    }
    const body = { date: form.date, label: form.label.trim(), amount, note: form.note || null };
    if (editingId) updateMutation.mutate({ id: editingId, body });
    else createMutation.mutate(body);
  }

  function openEdit(r: OtherIncomeEntry) {
    setEditingId(r.id);
    setForm({ date: r.date.slice(0, 10), label: r.label, amount: String(Number(r.amount)), note: r.note ?? '' });
    setOpen(true);
  }

  function openCreate() {
    setEditingId(null);
    setForm({ date: today(), label: '', amount: '', note: '' });
    setOpen(true);
  }

  const total = rows.reduce((s, r) => s + Number(r.amount), 0);

  const actions = (
    <>
      <ExportButtons filename="Other_Income" title="Other Income" subtitle={`${rows.length} entry(s)`} columns={OTHER_INCOME_COLUMNS} rows={rows} />
      <Button onClick={openCreate}><Plus className="h-4 w-4 mr-1.5" /> Record</Button>
    </>
  );

  return (
    <div className="space-y-7">
      {embedded ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">Any income that doesn't fit Kata, Hamali margin or Gunny Bag sales. Added to the husk recovery pool and the Profit &amp; Loss.</p>
          <div className="flex items-center gap-2">{actions}</div>
        </div>
      ) : (
        <PageHeader
          icon={PiggyBank}
          title="Other Income"
          description="Any income that doesn't fit Kata, Hamali margin or Gunny Bag sales. Added to the husk recovery pool and the Profit & Loss."
          actions={actions}
        />
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <StatCard label="Total other income" value={rupees(total)} icon={PiggyBank} tone="forest" hint="to husk pool" />
        <StatCard label="Entries" value={rows.length} icon={PiggyBank} tone="amber" hint="recorded" />
      </div>

      <div className="rounded-lg border bg-card overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Label</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Note</TableHead>
              <TableHead className="text-center">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={5} className="text-center py-8"><Loader2 className="h-6 w-6 animate-spin text-primary inline" /></TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">No other income recorded yet.</TableCell></TableRow>
            ) : rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{shortDate(r.date)}</TableCell>
                <TableCell className="font-medium">{r.label}</TableCell>
                <TableCell className="text-right font-mono tabular-nums text-emerald-600 dark:text-emerald-400">{rupees(r.amount)}</TableCell>
                <TableCell className="text-muted-foreground">{r.note ?? '-'}</TableCell>
                <TableCell className="text-center">
                  <div className="flex items-center justify-center gap-1">
                    <Button size="icon" variant="ghost" onClick={() => openEdit(r)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => deleteMutation.mutate(r.id)} disabled={deleteMutation.isPending}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setEditingId(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>{editingId ? 'Edit' : 'Record'} Other Income</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label>Date</Label>
              <Input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>Label</Label>
              <Input placeholder="e.g. Rent received, commission" value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>Amount (₹)</Label>
              <Input type="number" step="0.01" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>Note (optional)</Label>
              <Input value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={createMutation.isPending || updateMutation.isPending}>
              {(createMutation.isPending || updateMutation.isPending) ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
