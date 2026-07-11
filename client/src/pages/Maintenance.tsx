import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Wrench, Plus, Loader2, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { rupees, shortDate } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface MaintenanceExpense {
  id: string;
  date: string;
  description: string;
  amount: string;
  note: string | null;
}

const today = () => new Date().toISOString().slice(0, 10);

export default function Maintenance() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ date: today(), description: '', amount: '', note: '' });

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['maintenance-expenses'],
    queryFn: () => api<MaintenanceExpense[]>('/maintenance-expenses'),
  });

  const createMutation = useMutation({
    mutationFn: (body: any) => api('/maintenance-expenses', { method: 'POST', body }),
    onSuccess: () => {
      toast.success('Maintenance expense recorded');
      qc.invalidateQueries({ queryKey: ['maintenance-expenses'] });
      qc.invalidateQueries({ queryKey: ['husk-pnl'] });
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['journal-entries'] });
      setOpen(false);
      setForm({ date: today(), description: '', amount: '', note: '' });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/maintenance-expenses/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Expense deleted');
      qc.invalidateQueries({ queryKey: ['maintenance-expenses'] });
      qc.invalidateQueries({ queryKey: ['husk-pnl'] });
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['journal-entries'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function submit() {
    const amount = parseFloat(form.amount);
    if (!form.date || !form.description.trim() || !Number.isFinite(amount) || amount < 0) {
      toast.error('Enter a valid date, description and amount');
      return;
    }
    createMutation.mutate({ date: form.date, description: form.description.trim(), amount, note: form.note || null });
  }

  const total = rows.reduce((s, r) => s + Number(r.amount), 0);

  return (
    <div className="space-y-7">
      <PageHeader
        icon={Wrench}
        title="Maintenance"
        description="Factory maintenance expenses (QED AMC, repairs, etc.). Deducted from the husk recovery pool."
        actions={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4 mr-1.5" /> Record</Button>}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <StatCard label="Total maintenance" value={rupees(total)} icon={Wrench} tone="amber" hint="to husk pool" />
        <StatCard label="Entries" value={rows.length} icon={Wrench} tone="forest" hint="recorded" />
      </div>

      <div className="rounded-lg border bg-card overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Note</TableHead>
              <TableHead className="text-center">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={5} className="text-center py-8"><Loader2 className="h-6 w-6 animate-spin text-primary inline" /></TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">No maintenance expenses yet.</TableCell></TableRow>
            ) : rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{shortDate(r.date)}</TableCell>
                <TableCell className="font-medium">{r.description}</TableCell>
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
          <DialogHeader><DialogTitle>Record Maintenance Expense</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label>Date</Label>
              <Input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>Description</Label>
              <Input placeholder="e.g. QED AMC, factory repair" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
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
            <Button onClick={submit} disabled={createMutation.isPending}>
              {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
