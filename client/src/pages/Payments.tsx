import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, Wallet } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { Payment, Party, Broker } from '@/lib/types';
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

const PAYMENT_TYPES = [
  { value: 'SUPPLIER', label: 'Supplier Payment' },
  { value: 'TRANSPORTER', label: 'Transporter Freight' },
  { value: 'BROKER', label: 'Broker Commission' },
  { value: 'OTHER', label: 'Other Expense' },
] as const;

export default function PaymentsPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data: payments, isLoading } = useQuery({
    queryKey: ['payments'],
    queryFn: () => api<Payment[]>('/payments'),
  });

  const { data: parties } = useQuery({
    queryKey: ['parties'],
    queryFn: () => api<Party[]>('/parties'),
  });

  const { data: brokers } = useQuery({
    queryKey: ['brokers'],
    queryFn: () => api<Broker[]>('/brokers'),
  });

  const suppliers = parties?.filter((p) => p.type !== 'BUYER') ?? [];

  // Form State
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState('');
  const [type, setType] = useState<Payment['type']>('SUPPLIER');
  const [partyId, setPartyId] = useState('');
  const [brokerId, setBrokerId] = useState('');
  const [lorryNumber, setLorryNumber] = useState('');
  const [reference, setReference] = useState('');
  const [description, setDescription] = useState('');

  function resetForm() {
    setDate(new Date().toISOString().slice(0, 10));
    setAmount('');
    setType('SUPPLIER');
    setPartyId('');
    setBrokerId('');
    setLorryNumber('');
    setReference('');
    setDescription('');
  }

  const mutation = useMutation({
    mutationFn: () =>
      api<Payment>('/payments', {
        method: 'POST',
        body: {
          date,
          amount: Number(amount) || 0,
          type,
          partyId: type === 'SUPPLIER' ? partyId || null : null,
          brokerId: type === 'BROKER' ? brokerId || null : null,
          lorryNumber: type === 'TRANSPORTER' ? lorryNumber || null : null,
          reference: reference || null,
          description: description || null,
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['journal-entries'] });
      toast.success('Payment recorded successfully');
      setOpen(false);
      resetForm();
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/payments/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['journal-entries'] });
      toast.success('Payment reversed');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const isValid =
    Number(amount) > 0 &&
    (type !== 'SUPPLIER' || partyId) &&
    (type !== 'BROKER' || brokerId);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Payments</h1>
          <p className="text-muted-foreground">
            Record cash or bank payments to suppliers, transporters, brokers, or other expenses. Automatically generates general ledger postings.
          </p>
        </div>
        <Button onClick={() => { resetForm(); setOpen(true); }}>
          <Plus className="h-4 w-4" /> Record Payment
        </Button>
      </div>

      <div className="rounded-lg border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Paid To</TableHead>
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
            {payments?.length === 0 && (
              <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">No payments recorded yet.</TableCell></TableRow>
            )}
            {payments?.map((p) => {
              let paidToText = '—';
              if (p.type === 'SUPPLIER') {
                paidToText = p.party?.name ?? '—';
              } else if (p.type === 'BROKER') {
                paidToText = p.broker?.name ?? '—';
              } else if (p.type === 'TRANSPORTER') {
                paidToText = p.lorryNumber ? `Transporter (Lorry ${p.lorryNumber})` : 'Transporter';
              } else {
                paidToText = 'Other Expense';
              }

              return (
                <TableRow key={p.id}>
                  <TableCell>{shortDate(p.date)}</TableCell>
                  <TableCell className="font-semibold text-xs text-muted-foreground">
                    {PAYMENT_TYPES.find((t) => t.value === p.type)?.label}
                  </TableCell>
                  <TableCell className="font-medium">{paidToText}</TableCell>
                  <TableCell className="font-mono text-xs">{p.reference ?? '—'}</TableCell>
                  <TableCell className="max-w-xs truncate text-muted-foreground">{p.description ?? '—'}</TableCell>
                  <TableCell className="text-right font-bold text-rose-600 dark:text-rose-400">{rupees(p.amount)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        if (confirm(`Reverse this payment of ${rupees(p.amount)}? This will remove its associated general ledger journal entry.`)) {
                          deleteMutation.mutate(p.id);
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
            <DialogTitle>Record Payment</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="date">Payment Date</Label>
                <Input id="date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="amount">Amount (₹)</Label>
                <Input id="amount" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 50000" />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Payment Type</Label>
              <Select value={type} onValueChange={(val: any) => { setType(val); setPartyId(''); setBrokerId(''); setLorryNumber(''); }}>
                <SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger>
                <SelectContent>
                  {PAYMENT_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {type === 'SUPPLIER' && (
              <div className="space-y-2">
                <Label>Supplier</Label>
                <Select value={partyId} onValueChange={setPartyId}>
                  <SelectTrigger><SelectValue placeholder="Select supplier" /></SelectTrigger>
                  <SelectContent>
                    {suppliers.map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {type === 'BROKER' && (
              <div className="space-y-2">
                <Label>Broker</Label>
                <Select value={brokerId} onValueChange={setBrokerId}>
                  <SelectTrigger><SelectValue placeholder="Select broker" /></SelectTrigger>
                  <SelectContent>
                    {brokers?.map((b) => (
                      <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {type === 'TRANSPORTER' && (
              <div className="space-y-2">
                <Label htmlFor="lorry">Lorry / Vehicle Number</Label>
                <Input id="lorry" value={lorryNumber} onChange={(e) => setLorryNumber(e.target.value)} placeholder="e.g. AP02AB1234" />
                <p className="text-[10px] text-muted-foreground">Required to match freight charges to the corresponding vehicle.</p>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="ref">Reference (Cheque / UTR / Cash)</Label>
              <Input id="ref" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. UTR123456789" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="desc">Description</Label>
              <Input id="desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional comments" />
            </div>

            <DialogFooter>
              <Button onClick={() => mutation.mutate()} disabled={!isValid || mutation.isPending}>
                {mutation.isPending ? 'Saving…' : 'Record Payment'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
