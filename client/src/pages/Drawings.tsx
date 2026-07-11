import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { HandCoins, Plus, Loader2, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { rupees, shortDate } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Owner = 'SHABRI' | 'REDDY';

interface Drawing {
  id: string;
  date: string;
  owner: Owner;
  amount: string;
  note: string | null;
}

const today = () => new Date().toISOString().slice(0, 10);

export default function Drawings() {
  return (
    <div className="space-y-7">
      <PageHeader
        icon={HandCoins}
        title="Drawings"
        description="Owner drawings. Each drawing is deducted from the husk recovery pool."
      />
      <Tabs defaultValue="SHABRI">
        <TabsList>
          <TabsTrigger value="SHABRI">Shabri</TabsTrigger>
          <TabsTrigger value="REDDY">Reddy</TabsTrigger>
        </TabsList>
        <TabsContent value="SHABRI" className="mt-5">
          <OwnerPanel owner="SHABRI" />
        </TabsContent>
        <TabsContent value="REDDY" className="mt-5">
          <OwnerPanel owner="REDDY" />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function OwnerPanel({ owner }: { owner: Owner }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ date: today(), amount: '', note: '' });
  const label = owner === 'SHABRI' ? 'Shabri' : 'Reddy';

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['drawings', owner],
    queryFn: () => api<Drawing[]>(`/drawings?owner=${owner}`),
  });

  const createMutation = useMutation({
    mutationFn: (body: any) => api('/drawings', { method: 'POST', body }),
    onSuccess: () => {
      toast.success(`Drawing recorded for ${label}`);
      qc.invalidateQueries({ queryKey: ['drawings', owner] });
      qc.invalidateQueries({ queryKey: ['husk-pnl'] });
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['journal-entries'] });
      setOpen(false);
      setForm({ date: today(), amount: '', note: '' });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/drawings/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Drawing deleted');
      qc.invalidateQueries({ queryKey: ['drawings', owner] });
      qc.invalidateQueries({ queryKey: ['husk-pnl'] });
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['journal-entries'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function submit() {
    const amount = parseFloat(form.amount);
    if (!form.date || !Number.isFinite(amount) || amount <= 0) {
      toast.error('Enter a valid date and amount');
      return;
    }
    createMutation.mutate({ date: form.date, owner, amount, note: form.note || null });
  }

  const total = rows.reduce((s, r) => s + Number(r.amount), 0);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <StatCard label={`${label} - total drawings`} value={rupees(total)} icon={HandCoins} tone="amber" hint="to husk pool" className="flex-1 max-w-xs" />
        <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4 mr-1.5" /> Record</Button>
      </div>

      <div className="rounded-lg border bg-card overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Note</TableHead>
              <TableHead className="text-center">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={4} className="text-center py-8"><Loader2 className="h-6 w-6 animate-spin text-primary inline" /></TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground py-8">No drawings recorded for {label}.</TableCell></TableRow>
            ) : rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{shortDate(r.date)}</TableCell>
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
          <DialogHeader><DialogTitle>Record Drawing - {label}</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label>Date</Label>
              <Input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>Amount (₹)</Label>
              <Input type="number" step="0.01" placeholder="e.g. 50000" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} />
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
