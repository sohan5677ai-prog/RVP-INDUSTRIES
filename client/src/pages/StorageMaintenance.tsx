import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Zap, Users, Plus, Loader2, Trash2, type LucideIcon } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { rupees, shortDate } from '@/lib/format';
import { StatCard } from '@/components/StatCard';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';

type Kind = 'ELECTRICITY' | 'SALARY';

interface StorageEntry {
  id: string;
  date: string;
  kind: Kind;
  label: string | null;
  amount: string;
  note: string | null;
}

const today = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => new Date().toISOString().slice(0, 7);

/** Storage-facility running costs. Two independent record-keeping sections. */
export default function StorageMaintenance() {
  return (
    <div className="space-y-8">
      <p className="text-sm text-muted-foreground">
        Storage godown running costs. Each entry is deducted from the husk recovery pool and posts to
        the Profit &amp; Loss as an operating expense.
      </p>
      <StorageSection
        kind="ELECTRICITY"
        title="Electricity Bill"
        labelField="Month"
        labelPlaceholder="e.g. 2026-07"
        labelType="month"
        defaultLabel={thisMonth()}
        icon={Zap}
      />
      <StorageSection
        kind="SALARY"
        title="Salaries"
        labelField="Employee / description"
        labelPlaceholder="e.g. Watchman - July"
        icon={Users}
      />
    </div>
  );
}

function StorageSection({
  kind,
  title,
  labelField,
  labelPlaceholder,
  labelType = 'text',
  defaultLabel = '',
  icon: Icon,
}: {
  kind: Kind;
  title: string;
  labelField: string;
  labelPlaceholder: string;
  labelType?: 'text' | 'month';
  defaultLabel?: string;
  icon: LucideIcon;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ date: today(), label: defaultLabel, amount: '', note: '' });

  const columns: ExportColumn<StorageEntry>[] = [
    { header: 'Date', value: (r) => shortDate(r.date) },
    { header: labelField, value: (r) => r.label ?? '' },
    { header: 'Amount', value: (r) => rupees(r.amount), excel: (r) => Number(r.amount), numFmt: '#,##0.00', align: 'right' },
    { header: 'Note', value: (r) => r.note ?? '' },
  ];

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['storage-maintenance', kind],
    queryFn: () => api<StorageEntry[]>(`/storage-maintenance?kind=${kind}`),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['storage-maintenance', kind] });
    qc.invalidateQueries({ queryKey: ['husk-pnl'] });
    qc.invalidateQueries({ queryKey: ['profit-loss'] });
    qc.invalidateQueries({ queryKey: ['payments'] });
    qc.invalidateQueries({ queryKey: ['accounts'] });
    qc.invalidateQueries({ queryKey: ['journal-entries'] });
  };

  const createMutation = useMutation({
    mutationFn: (body: any) => api('/storage-maintenance', { method: 'POST', body }),
    onSuccess: () => {
      toast.success(`${title} recorded`);
      invalidate();
      setOpen(false);
      setForm({ date: today(), label: defaultLabel, amount: '', note: '' });
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/storage-maintenance/${id}`, { method: 'DELETE' }),
    onSuccess: () => { toast.success('Entry deleted'); invalidate(); },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  function submit() {
    const amount = parseFloat(form.amount);
    if (!form.date || !Number.isFinite(amount) || amount <= 0) {
      toast.error('Enter a valid date and amount');
      return;
    }
    createMutation.mutate({ date: form.date, kind, label: form.label.trim() || null, amount, note: form.note || null });
  }

  const total = rows.reduce((s, r) => s + Number(r.amount), 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon className="h-5 w-5 text-primary" />
          <h3 className="font-display text-base font-semibold tracking-tight">{title}</h3>
        </div>
        <div className="flex items-center gap-2">
          <ExportButtons filename={`Storage_${title.replace(/\s+/g, '_')}`} title={`Storage ${title}`} columns={columns} rows={rows} />
          <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4 mr-1.5" /> Record</Button>
        </div>
      </div>

      <StatCard label={`Total ${title.toLowerCase()}`} value={rupees(total)} icon={Icon} tone="amber" hint="to husk pool & P&L" className="max-w-xs" />

      <div className="rounded-lg border bg-card overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>{labelField}</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Note</TableHead>
              <TableHead className="text-center w-16">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={5} className="text-center py-8"><Loader2 className="h-6 w-6 animate-spin text-primary inline" /></TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">No {title.toLowerCase()} recorded yet.</TableCell></TableRow>
            ) : rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{shortDate(r.date)}</TableCell>
                <TableCell className="font-medium">{r.label ?? '-'}</TableCell>
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
          <DialogHeader><DialogTitle>Record {title}</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label>Date</Label>
              <Input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>{labelField}</Label>
              <Input type={labelType} placeholder={labelPlaceholder} value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>Amount (₹)</Label>
              <Input type="number" step="0.01" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} placeholder="e.g. 12000" />
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
