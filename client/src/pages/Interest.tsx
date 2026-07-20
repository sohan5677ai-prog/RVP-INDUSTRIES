import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Percent, Plus, Loader2, Trash2, Landmark } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { rupees, shortDate } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PaginationBar } from '@/components/ui/pagination-bar';
import { usePagedRows } from '@/lib/usePagedRows';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';

type InterestType = 'CC' | 'TERM_LOAN';

// Shared shape for the amount/note tables on this page.
const AMOUNT_NOTE_COLUMNS: ExportColumn<{ date: string; amount: string; note: string | null }>[] = [
  { header: 'Date', value: (r) => shortDate(r.date) },
  { header: 'Amount', value: (r) => rupees(r.amount), excel: (r) => Number(r.amount), numFmt: '#,##0.00', align: 'right' },
  { header: 'Note', value: (r) => r.note ?? '' },
];

interface InterestCharge {
  id: string;
  date: string;
  type: InterestType;
  amount: string;
  note: string | null;
}

const today = () => new Date().toISOString().slice(0, 10);

export default function Interest({ embedded = false }: { embedded?: boolean } = {}) {
  return (
    <div className="space-y-6">
      {!embedded && (
        <PageHeader
          icon={Percent}
          title="Interest"
          description="Bank loan interest charged on cash-credit and term-loan facilities. Deducted from the husk pool and the Profit & Loss as an operating expense."
        />
      )}
      <Tabs defaultValue="cc" className="gap-4">
        <TabsList>
          <TabsTrigger value="cc">CC Interest</TabsTrigger>
          <TabsTrigger value="term">Term Loan</TabsTrigger>
        </TabsList>

        <TabsContent value="cc">
          <InterestPanel type="CC" label="CC interest" hint="Cash-credit facility" />
        </TabsContent>
        <TabsContent value="term">
          <Tabs defaultValue="interest" className="gap-4">
            <TabsList>
              <TabsTrigger value="principal">Principal</TabsTrigger>
              <TabsTrigger value="interest">Interest</TabsTrigger>
            </TabsList>
            <TabsContent value="principal">
              <PrincipalPanel />
            </TabsContent>
            <TabsContent value="interest">
              <InterestPanel type="TERM_LOAN" label="Term loan interest" hint="Term-loan facility" />
            </TabsContent>
          </Tabs>
        </TabsContent>
      </Tabs>
    </div>
  );
}

interface PrincipalEntry {
  id: string;
  date: string;
  amount: string;
  note: string | null;
}

/**
 * Term-loan principal repayments
 */
function PrincipalPanel() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ date: today(), amount: '', note: '' });

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['term-loan-principals'],
    queryFn: () => api<PrincipalEntry[]>('/term-loan-principals'),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['term-loan-principals'] });
    qc.invalidateQueries({ queryKey: ['husk-pnl'] });
    qc.invalidateQueries({ queryKey: ['profit-loss'] });
    qc.invalidateQueries({ queryKey: ['payments'] });
    qc.invalidateQueries({ queryKey: ['accounts'] });
    qc.invalidateQueries({ queryKey: ['journal-entries'] });
  };

  const createMutation = useMutation({
    mutationFn: (body: any) => api('/term-loan-principals', { method: 'POST', body }),
    onSuccess: () => {
      toast.success('Principal payment recorded');
      invalidate();
      setOpen(false);
      setForm({ date: today(), amount: '', note: '' });
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/term-loan-principals/${id}`, { method: 'DELETE' }),
    onSuccess: () => { toast.success('Principal entry deleted'); invalidate(); },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  function submit() {
    const amount = parseFloat(form.amount);
    if (!form.date || !Number.isFinite(amount) || amount <= 0) {
      toast.error('Enter a valid date and amount');
      return;
    }
    createMutation.mutate({ date: form.date, amount, note: form.note || null });
  }

  const total = rows.reduce((s, r) => s + Number(r.amount), 0);
  const { page, setPage, pageSize, setPageSize, totalPages, total: totalRows, pageRows = [] } = usePagedRows(rows, 50);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <StatCard label="Total principal paid" value={rupees(total)} icon={Landmark} tone="forest" hint="term-loan principal" />
        <StatCard label="Entries" value={rows.length} icon={Percent} tone="amber" hint="Term-loan facility" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Track principal repaid on the term loan. Each entry posts a linked payment and reduces the Profit &amp; Loss.
        </p>
        <div className="flex items-center gap-2">
          <ExportButtons filename="Term_Loan_Principal" title="Term Loan Principal Repayments" columns={AMOUNT_NOTE_COLUMNS} rows={rows} />
          <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4 mr-1.5" /> Record</Button>
        </div>
      </div>

      <div className="rounded-lg border bg-card overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Note</TableHead>
              <TableHead className="text-center w-16">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={4} className="text-center py-8"><Loader2 className="h-6 w-6 animate-spin text-primary inline" /></TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground py-8">No principal payments recorded yet.</TableCell></TableRow>
            ) : pageRows.map((r) => (
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
        <PaginationBar page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalPages={totalPages} total={totalRows} />
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Record principal payment</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label>Date</Label>
              <Input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>Amount (₹)</Label>
              <Input type="number" step="0.01" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} placeholder="e.g. 100000" />
            </div>
            <div className="space-y-1">
              <Label>Note (optional)</Label>
              <Input value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} placeholder="e.g. May EMI principal" />
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

function InterestPanel({ type, label, hint }: { type: InterestType; label: string; hint: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ date: today(), amount: '', note: '' });

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['interest-charges', type],
    queryFn: () => api<InterestCharge[]>(`/interest-charges?type=${type}`),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['interest-charges', type] });
    qc.invalidateQueries({ queryKey: ['husk-pnl'] });
    qc.invalidateQueries({ queryKey: ['profit-loss'] });
    qc.invalidateQueries({ queryKey: ['payments'] });
    qc.invalidateQueries({ queryKey: ['accounts'] });
    qc.invalidateQueries({ queryKey: ['journal-entries'] });
  };

  const createMutation = useMutation({
    mutationFn: (body: any) => api('/interest-charges', { method: 'POST', body }),
    onSuccess: () => {
      toast.success(`${label} recorded`);
      invalidate();
      setOpen(false);
      setForm({ date: today(), amount: '', note: '' });
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/interest-charges/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Interest charge deleted');
      invalidate();
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  function submit() {
    const amount = parseFloat(form.amount);
    if (!form.date || !Number.isFinite(amount) || amount <= 0) {
      toast.error('Enter a valid date and amount');
      return;
    }
    createMutation.mutate({ date: form.date, type, amount, note: form.note || null });
  }

  const total = rows.reduce((s, r) => s + Number(r.amount), 0);
  const { page, setPage, pageSize, setPageSize, totalPages, total: totalRows, pageRows = [] } = usePagedRows(rows, 50);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <StatCard label={`Total ${label}`} value={rupees(total)} icon={Landmark} tone="amber" hint="to husk pool" />
        <StatCard label="Entries" value={rows.length} icon={Percent} tone="forest" hint={hint} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Record the interest the bank charged. Each entry posts a linked payment and reduces the Profit &amp; Loss.
        </p>
        <div className="flex items-center gap-2">
          <ExportButtons filename={`${label.replace(/\s+/g, '_')}`} title={label} columns={AMOUNT_NOTE_COLUMNS} rows={rows} />
          <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4 mr-1.5" /> Record</Button>
        </div>
      </div>

      <div className="rounded-lg border bg-card overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Note</TableHead>
              <TableHead className="text-center w-16">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={4} className="text-center py-8"><Loader2 className="h-6 w-6 animate-spin text-primary inline" /></TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground py-8">No {label.toLowerCase()} recorded yet.</TableCell></TableRow>
            ) : pageRows.map((r) => (
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
        <PaginationBar page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalPages={totalPages} total={totalRows} />
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Record {label}</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label>Date</Label>
              <Input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>Amount (₹)</Label>
              <Input type="number" step="0.01" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} placeholder="e.g. 45000" />
            </div>
            <div className="space-y-1">
              <Label>Note (optional)</Label>
              <Input value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} placeholder="e.g. May statement" />
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
