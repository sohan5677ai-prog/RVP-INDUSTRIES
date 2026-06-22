import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, Receipt } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { Receipt as ReceiptType, Party } from '@/lib/types';
import { rupees, shortDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

const RECEIPT_TYPES = [
  { value: 'BUYER', label: 'Buyer Collection' },
  { value: 'OTHER', label: 'Other Receipt / Revenue' },
] as const;

export default function ReceiptsPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data: receipts, isLoading } = useQuery({
    queryKey: ['receipts'],
    queryFn: () => api<ReceiptType[]>('/receipts'),
  });

  const { data: parties } = useQuery({
    queryKey: ['parties'],
    queryFn: () => api<Party[]>('/parties'),
  });

  const buyers = parties?.filter((p) => p.type === 'BUYER') ?? [];

  // Form State
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState('');
  const [type, setType] = useState<ReceiptType['type']>('BUYER');
  const [partyId, setPartyId] = useState('');
  const [reference, setReference] = useState('');
  const [description, setDescription] = useState('');

  function resetForm() {
    setDate(new Date().toISOString().slice(0, 10));
    setAmount('');
    setType('BUYER');
    setPartyId('');
    setReference('');
    setDescription('');
  }

  const mutation = useMutation({
    mutationFn: () =>
      api<ReceiptType>('/receipts', {
        method: 'POST',
        body: {
          date,
          amount: Number(amount) || 0,
          type,
          partyId: type === 'BUYER' ? partyId || null : null,
          reference: reference || null,
          description: description || null,
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['receipts'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['journal-entries'] });
      toast.success('Receipt recorded successfully');
      setOpen(false);
      resetForm();
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/receipts/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['receipts'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['journal-entries'] });
      toast.success('Receipt reversed');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const isValid =
    Number(amount) > 0 &&
    (type !== 'BUYER' || partyId);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Receipts</h1>
          <p className="text-muted-foreground">
            Record cash or bank receipts from buyers (accounts receivable collection) or other income. Automatically generates general ledger journal entries.
          </p>
        </div>
        <Button onClick={() => { resetForm(); setOpen(true); }}>
          <Plus className="h-4 w-4" /> Record Receipt
        </Button>
      </div>

      <div className="rounded-lg border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Received From</TableHead>
              <TableHead>Ref / Cheque</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="w-16 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">Loading…</TableCell></TableRow>
            )}
            {receipts?.length === 0 && (
              <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">No receipts recorded yet.</TableCell></TableRow>
            )}
            {receipts?.map((r) => {
              let receivedFromText = '—';
              if (r.type === 'BUYER') {
                receivedFromText = r.party?.name ?? '—';
              } else {
                receivedFromText = 'Other Income / Revenue';
              }

              return (
                <TableRow key={r.id}>
                  <TableCell>{shortDate(r.date)}</TableCell>
                  <TableCell className="font-semibold text-xs text-muted-foreground">
                    {RECEIPT_TYPES.find((t) => t.value === r.type)?.label}
                  </TableCell>
                  <TableCell className="font-medium">{receivedFromText}</TableCell>
                  <TableCell className="font-mono text-xs">{r.reference ?? '—'}</TableCell>
                  <TableCell className="max-w-xs truncate text-muted-foreground">{r.description ?? '—'}</TableCell>
                  <TableCell className="text-right font-bold text-emerald-600 dark:text-emerald-400">{rupees(r.amount)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        if (confirm(`Reverse this receipt of ${rupees(r.amount)}? This will remove its associated general ledger journal entry.`)) {
                          deleteMutation.mutate(r.id);
                        }
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Record Receipt</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="date">Receipt Date</Label>
                <Input id="date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="amount">Amount (₹)</Label>
                <Input id="amount" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 100000" />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Receipt Type</Label>
              <Select value={type} onValueChange={(val: any) => { setType(val); setPartyId(''); }}>
                <SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger>
                <SelectContent>
                  {RECEIPT_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {type === 'BUYER' && (
              <div className="space-y-2">
                <Label>Buyer</Label>
                <Select value={partyId} onValueChange={setPartyId}>
                  <SelectTrigger><SelectValue placeholder="Select buyer" /></SelectTrigger>
                  <SelectContent>
                    {buyers.map((b) => (
                      <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="ref">Reference (Cheque / UTR / Cash)</Label>
              <Input id="ref" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. Cheque No 012345" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="desc">Description</Label>
              <Input id="desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional comments" />
            </div>

            <DialogFooter>
              <Button onClick={() => mutation.mutate()} disabled={!isValid || mutation.isPending}>
                {mutation.isPending ? 'Saving…' : 'Record Receipt'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
