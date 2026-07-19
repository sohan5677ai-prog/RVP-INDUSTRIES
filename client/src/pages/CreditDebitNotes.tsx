import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Mail, FileText, FileMinus2, ReceiptText } from 'lucide-react';
import { api, getErrorMessage, getToken } from '@/lib/api';
import { usePagedRows } from '@/lib/usePagedRows';
import { PaginationBar } from '@/components/ui/pagination-bar';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import { rupees, shortDate } from '@/lib/format';
import type { CreditNote, DebitNote, Party, SaleOrder, PendingCreditNote } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type NoteKind = 'CREDIT' | 'DEBIT';

/** Fetch a note PDF with the auth header and open it in a new tab (window.open
 * with a raw path would miss the Authorization header this API requires). */
async function openNotePdf(kind: NoteKind, id: string) {
  const base = import.meta.env.VITE_API_URL ?? '/api';
  const token = getToken();
  const res = await fetch(`${base}/${kind === 'CREDIT' ? 'credit-notes' : 'debit-notes'}/${id}/pdf`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) { toast.error('Failed to load PDF'); return; }
  const blob = await res.blob();
  window.open(URL.createObjectURL(blob), '_blank');
}

function NotesTable({
  kind,
  notes,
  isLoading,
  onSend,
  sendingId,
}: {
  kind: NoteKind;
  notes: (CreditNote | DebitNote)[];
  isLoading: boolean;
  onSend: (id: string) => void;
  sendingId: string | null;
}) {
  const { page, setPage, pageSize, setPageSize, totalPages, total, pageRows = [] } = usePagedRows(notes, 50);

  return (
    <div className="rounded-lg border bg-card overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Note No.</TableHead>
            <TableHead>Date</TableHead>
            <TableHead>Party</TableHead>
            <TableHead>Reason</TableHead>
            <TableHead className="text-right">Taxable</TableHead>
            <TableHead className="text-right">GST</TableHead>
            <TableHead className="text-right">Total</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading && (
            <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground">Loading…</TableCell></TableRow>
          )}
          {!isLoading && notes.length === 0 && (
            <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground">No {kind === 'CREDIT' ? 'credit' : 'debit'} notes yet.</TableCell></TableRow>
          )}
          {pageRows.map((n) => (
            <TableRow key={n.id}>
              <TableCell className="font-mono text-sm font-semibold">{n.noteNumber}</TableCell>
              <TableCell>{shortDate(n.noteDate)}</TableCell>
              <TableCell className="font-medium">{n.party?.name ?? '-'}</TableCell>
              <TableCell className="max-w-xs truncate text-muted-foreground">{n.reason}</TableCell>
              <TableCell className="text-right">{rupees(n.taxableValue)}</TableCell>
              <TableCell className="text-right">{rupees(n.gstAmount)}</TableCell>
              <TableCell className="text-right font-bold">{rupees(n.totalAmount)}</TableCell>
              <TableCell>
                <Badge variant={n.status === 'CANCELLED' ? 'destructive' : 'success'}>{n.status}</Badge>
              </TableCell>
              <TableCell className="text-right space-x-1.5">
                <Button size="sm" variant="outline" onClick={() => openNotePdf(kind, n.id)}>
                  <FileText className="h-3.5 w-3.5 mr-1.5" /> PDF
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  title={n.party?.email ? undefined : 'Add an email in Parties first'}
                  disabled={!n.party?.email || sendingId === n.id}
                  onClick={() => onSend(n.id)}
                >
                  <Mail className="h-3.5 w-3.5 mr-1.5" /> Send
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <PaginationBar page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalPages={totalPages} total={total} />
    </div>
  );
}

function PendingShortagesCard({
  items,
  isLoading,
  onRaise,
}: {
  items: PendingCreditNote[];
  isLoading: boolean;
  onRaise: (item: PendingCreditNote) => void;
}) {
  if (!isLoading && items.length === 0) return null;

  return (
    <div className="rounded-lg border bg-card overflow-x-auto">
      <div className="px-4 py-3 border-b">
        <h3 className="text-sm font-semibold flex items-center gap-1.5"><ReceiptText className="h-4 w-4" /> Recorded Shortages Awaiting a Credit Note</h3>
        <p className="text-xs text-muted-foreground mt-0.5">Already posted to the party ledger — raise a formal note to send to the buyer.</p>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Invoice</TableHead>
            <TableHead>Date</TableHead>
            <TableHead>Party</TableHead>
            <TableHead>Shortage</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading && (
            <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">Loading…</TableCell></TableRow>
          )}
          {items.map((item) => (
            <TableRow key={item.saleDispatchId}>
              <TableCell className="font-mono text-sm">{item.invoiceNumber ?? '-'}</TableCell>
              <TableCell>{shortDate(item.date)}</TableCell>
              <TableCell className="font-medium">{item.partyName}</TableCell>
              <TableCell className="text-muted-foreground">{item.shortageKg != null ? `${item.shortageKg} kg` : '-'}</TableCell>
              <TableCell className="text-right font-semibold">{rupees(item.totalAmount)}</TableCell>
              <TableCell className="text-right">
                <Button size="sm" onClick={() => onRaise(item)}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" /> Raise Note
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export default function CreditDebitNotes() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<NoteKind>('CREDIT');
  const [open, setOpen] = useState(false);

  const { data: creditNotes, isLoading: loadingCredit } = useQuery({
    queryKey: ['credit-notes'],
    queryFn: () => api<CreditNote[]>('/credit-notes'),
  });
  const { data: debitNotes, isLoading: loadingDebit } = useQuery({
    queryKey: ['debit-notes'],
    queryFn: () => api<DebitNote[]>('/debit-notes'),
  });
  const { data: parties } = useQuery({ queryKey: ['parties'], queryFn: () => api<Party[]>('/parties') });
  const { data: saleOrders } = useQuery({
    queryKey: ['sale-orders', { all: true }],
    queryFn: () => api<SaleOrder[]>('/sale-orders?all=true'),
  });
  const { data: pendingCreditNotes, isLoading: loadingPending } = useQuery({
    queryKey: ['credit-notes-pending'],
    queryFn: () => api<PendingCreditNote[]>('/credit-notes/pending'),
  });

  const buyers = parties?.filter((p) => p.type === 'BUYER' || p.type === 'BOTH') ?? [];

  // Form state
  const [partyId, setPartyId] = useState('');
  const [saleDispatchId, setSaleDispatchId] = useState('');
  const [reason, setReason] = useState('');
  const [taxableValue, setTaxableValue] = useState('');
  const [gstRate, setGstRate] = useState('5');
  const [noteDate, setNoteDate] = useState(() => new Date().toISOString().slice(0, 10));

  const dispatchOptions = useMemo(() => {
    if (!partyId || !saleOrders) return [];
    return saleOrders
      .filter((o) => o.buyerId === partyId)
      .flatMap((o) => (o.dispatches ?? []).filter((d) => d.invoiceNumber).map((d) => ({ id: d.id, label: `${d.invoiceNumber} · ${shortDate(d.dispatchDate)}` })));
  }, [partyId, saleOrders]);

  function resetForm() {
    setPartyId('');
    setSaleDispatchId('');
    setReason('');
    setTaxableValue('');
    setGstRate('5');
    setNoteDate(new Date().toISOString().slice(0, 10));
  }

  const createMutation = useMutation({
    mutationFn: () =>
      api(tab === 'CREDIT' ? '/credit-notes' : '/debit-notes', {
        method: 'POST',
        body: {
          partyId,
          saleDispatchId: saleDispatchId || undefined,
          noteDate,
          reason,
          taxableValue: Number(taxableValue) || 0,
          gstRate: Number(gstRate) || 0,
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [tab === 'CREDIT' ? 'credit-notes' : 'debit-notes'] });
      if (tab === 'CREDIT') qc.invalidateQueries({ queryKey: ['credit-notes-pending'] });
      toast.success(`${tab === 'CREDIT' ? 'Credit' : 'Debit'} note created`);
      setOpen(false);
      resetForm();
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const [sendingId, setSendingId] = useState<string | null>(null);
  const sendMutation = useMutation({
    mutationFn: ({ id, kind }: { id: string; kind: NoteKind }) =>
      api(`/${kind === 'CREDIT' ? 'credit-notes' : 'debit-notes'}/${id}/email`, { method: 'POST' }),
    onMutate: ({ id }) => setSendingId(id),
    onSuccess: () => toast.success('Note emailed to party'),
    onError: (e: Error) => toast.error(getErrorMessage(e)),
    onSettled: () => setSendingId(null),
  });

  function raiseNote(item: PendingCreditNote) {
    setTab('CREDIT');
    setPartyId(item.partyId);
    setSaleDispatchId(item.saleDispatchId);
    setReason(`Shortage of ${item.shortageKg ?? 0} kg${item.invoiceNumber ? ` on invoice ${item.invoiceNumber}` : ''}`);
    setTaxableValue(String(item.taxableValue));
    setGstRate(String(item.gstRate));
    setNoteDate(new Date().toISOString().slice(0, 10));
    setOpen(true);
  }

  const gstAmount = (Number(taxableValue) || 0) * (Number(gstRate) || 0) / 100;
  const totalAmount = (Number(taxableValue) || 0) + gstAmount;
  const isValid = partyId && reason.trim() && Number(taxableValue) > 0;

  const creditTotal = (creditNotes ?? []).reduce((s, n) => s + Number(n.totalAmount), 0);
  const debitTotal = (debitNotes ?? []).reduce((s, n) => s + Number(n.totalAmount), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Credit / Debit Notes"
        description="Raise and email GST-aware credit and debit notes to sale-side parties."
        icon={FileMinus2}
        actions={
          <Button onClick={() => { resetForm(); setOpen(true); }}>
            <Plus className="h-4 w-4" /> New {tab === 'CREDIT' ? 'Credit' : 'Debit'} Note
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-2">
        <StatCard label="Total Credit Notes" value={rupees(creditTotal)} tone="rose" icon={FileMinus2} hint={`${creditNotes?.length ?? 0} note(s)`} />
        <StatCard label="Total Debit Notes" value={rupees(debitTotal)} tone="forest" icon={FileMinus2} hint={`${debitNotes?.length ?? 0} note(s)`} />
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as NoteKind)}>
        <TabsList className="bg-card border shadow-sm">
          <TabsTrigger value="CREDIT">Credit Notes</TabsTrigger>
          <TabsTrigger value="DEBIT">Debit Notes</TabsTrigger>
        </TabsList>

        <TabsContent value="CREDIT" className="space-y-4">
          <PendingShortagesCard
            items={pendingCreditNotes ?? []}
            isLoading={loadingPending}
            onRaise={raiseNote}
          />
          <NotesTable
            kind="CREDIT"
            notes={creditNotes ?? []}
            isLoading={loadingCredit}
            sendingId={sendingId}
            onSend={(id) => sendMutation.mutate({ id, kind: 'CREDIT' })}
          />
        </TabsContent>
        <TabsContent value="DEBIT">
          <NotesTable
            kind="DEBIT"
            notes={debitNotes ?? []}
            isLoading={loadingDebit}
            sendingId={sendingId}
            onSend={(id) => sendMutation.mutate({ id, kind: 'DEBIT' })}
          />
        </TabsContent>
      </Tabs>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New {tab === 'CREDIT' ? 'Credit' : 'Debit'} Note</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Party</Label>
              <Select value={partyId} onValueChange={(v) => { setPartyId(v); setSaleDispatchId(''); }}>
                <SelectTrigger><SelectValue placeholder="Select party" /></SelectTrigger>
                <SelectContent>
                  {buyers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {dispatchOptions.length > 0 && (
              <div className="space-y-2">
                <Label>Reference Invoice (optional)</Label>
                <Select value={saleDispatchId} onValueChange={setSaleDispatchId}>
                  <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                  <SelectContent>
                    {dispatchOptions.map((d) => (
                      <SelectItem key={d.id} value={d.id}>{d.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="note-date">Date</Label>
                <Input id="note-date" type="date" value={noteDate} onChange={(e) => setNoteDate(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="gst-rate">GST %</Label>
                <Input id="gst-rate" type="number" step="0.01" value={gstRate} onChange={(e) => setGstRate(e.target.value)} />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="reason">Reason</Label>
              <Input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Rate correction, quality shortfall" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="taxable-value">Taxable Value (₹)</Label>
              <Input id="taxable-value" type="number" step="0.01" value={taxableValue} onChange={(e) => setTaxableValue(e.target.value)} />
            </div>

            <div className="rounded-md border bg-muted/30 p-3 text-sm space-y-1">
              <div className="flex justify-between"><span className="text-muted-foreground">GST Amount</span><span>{rupees(gstAmount)}</span></div>
              <div className="flex justify-between font-semibold"><span>Total</span><span>{rupees(totalAmount)}</span></div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={!isValid || createMutation.isPending} onClick={() => createMutation.mutate()}>
              {createMutation.isPending ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
