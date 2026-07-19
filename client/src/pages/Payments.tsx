import { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { PaginationBar } from '@/components/ui/pagination-bar';
import { ScreenshotUpload, nameKey, type ExtractedTransaction } from '@/components/ScreenshotUpload';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';
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
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import type { PaymentType } from '@/lib/types';

// Types you can record directly from this page. Gunny Bags, Electricity,
// Maintenance and Drawings are entered on their own detail pages (which auto-post
// a linked Payment here), so they are intentionally absent from this form.
const PAYMENT_TYPE_GROUPS: { label: string; items: { value: PaymentType; label: string }[] }[] = [
  {
    label: 'Suppliers & Counterparties',
    items: [
      { value: 'SUPPLIER', label: 'Supplier Payment' },
      { value: 'TRANSPORTER_INWARD', label: 'Transporter Freight (Inward)' },
      { value: 'TRANSPORTER_OUTWARD', label: 'Transporter Freight (Outward)' },
      { value: 'BROKER', label: 'Broker Commission' },
      { value: 'HAMALI', label: 'Hamali Payment' },
    ],
  },
  {
    label: 'Expenses',
    items: [
      { value: 'TRANSPORT', label: 'Transport Fee' },
      { value: 'OTHER', label: 'Other Expense' },
    ],
  },
];

// Full label map for rendering ANY payment in the table, including the ones
// auto-created from detail pages (which aren't offered in the form above).
const PAYMENT_TYPES: { value: PaymentType; label: string }[] = [
  ...PAYMENT_TYPE_GROUPS.flatMap((g) => g.items),
  { value: 'GUNNY_BAGS', label: 'Gunny Bags' },
  { value: 'ELECTRICITY', label: 'Electricity' },
  { value: 'MAINTENANCE', label: 'Repairs & Maintenance' },
  { value: 'DRAWINGS', label: 'Drawings' },
];

// Types that settle a specific counterparty (they have their own picker below).
// Everything else is a direct-cash expense/drawing that uses the free-text payee.
const COUNTERPARTY_TYPES: PaymentType[] = ['SUPPLIER', 'TRANSPORTER_INWARD', 'TRANSPORTER_OUTWARD', 'BROKER', 'HAMALI'];

// Payments created from a detail page (Gunny Bags / Electricity / Maintenance /
// Drawings). They're read-only here — edit or delete them on their own page so
// both sides stay in sync.
const MANAGED_ELSEWHERE: Partial<Record<PaymentType, string>> = {
  GUNNY_BAGS: 'Gunny Bags page',
  ELECTRICITY: 'Electricity page',
  MAINTENANCE: 'Maintenance page',
  DRAWINGS: 'Drawings page',
};

function paymentTypeLabel(p: Payment): string {
  return PAYMENT_TYPES.find((t) => t.value === p.type)?.label ?? p.type;
}

function paymentPaidTo(p: Payment): string {
  if (p.type === 'SUPPLIER' || p.type === 'HAMALI') return p.party?.name ?? '-';
  if (p.type === 'BROKER') return p.broker?.name ?? '-';
  if (p.type === 'TRANSPORTER_INWARD' || p.type === 'TRANSPORTER_OUTWARD') {
    return p.lorryNumber ? `Transporter (Lorry ${p.lorryNumber})` : 'Transporter';
  }
  return p.payee || paymentTypeLabel(p);
}

const PAYMENT_EXPORT_COLUMNS: ExportColumn<Payment>[] = [
  { header: 'Date', value: (p) => shortDate(p.date) },
  { header: 'Type', value: (p) => paymentTypeLabel(p) },
  { header: 'Paid To', value: (p) => paymentPaidTo(p) },
  { header: 'Ref / Cheque', value: (p) => p.reference ?? '' },
  { header: 'Description', value: (p) => p.description ?? '' },
  { header: 'Amount', value: (p) => rupees(p.amount), excel: (p) => Number(p.amount), numFmt: '#,##0.00', align: 'right' },
];

export default function PaymentsPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  // Server-side pagination: only the visible page is fetched, so opening the page
  // stays fast no matter how long the payment history grows. "All" (Infinity) and
  // the Export button still pull the full set on demand.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(50);
  useEffect(() => { setPage(1); }, [pageSize]);

  const { data: pageData, isLoading } = useQuery({
    queryKey: ['payments', { page, pageSize }],
    queryFn: () =>
      pageSize === Infinity
        ? api<Payment[]>('/payments?all=true').then((rows) => ({ rows, total: rows.length }))
        : api<{ rows: Payment[]; total: number }>(`/payments?skip=${(page - 1) * pageSize}&take=${pageSize}`),
    // Keep the previous page on screen while the next loads, so paging doesn't flash.
    placeholderData: keepPreviousData,
  });
  const visiblePayments = pageData?.rows ?? [];
  const total = pageData?.total ?? 0;
  const totalPages = pageSize === Infinity ? 1 : Math.max(1, Math.ceil(total / pageSize));

  const { data: parties } = useQuery({
    queryKey: ['parties'],
    queryFn: () => api<Party[]>('/parties'),
  });

  const { data: brokers } = useQuery({
    queryKey: ['brokers'],
    queryFn: () => api<Broker[]>('/brokers'),
  });

  const suppliers = useMemo(() => parties?.filter((p) => p.type !== 'BUYER' && p.type !== 'HAMALI_TEAM') ?? [], [parties]);
  const hamaliTeams = useMemo(() => parties?.filter((p) => p.type === 'HAMALI_TEAM') ?? [], [parties]);

  // Form State
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState('');
  const [type, setType] = useState<Payment['type']>('SUPPLIER');
  const [partyId, setPartyId] = useState('');
  const [brokerId, setBrokerId] = useState('');
  const [lorryNumber, setLorryNumber] = useState('');
  const [payee, setPayee] = useState('');
  const [reference, setReference] = useState('');
  const [description, setDescription] = useState('');
  // Retained so the proof screenshot is stored with the payment and WhatsApp'd
  // to the party.
  const [screenshotFile, setScreenshotFile] = useState<File | null>(null);

  function resetForm() {
    setDate(new Date().toISOString().slice(0, 10));
    setAmount('');
    setType('SUPPLIER');
    setPartyId('');
    setBrokerId('');
    setLorryNumber('');
    setPayee('');
    setReference('');
    setDescription('');
    setScreenshotFile(null);
  }

  /** Pre-fill the form from a payment screenshot read by the server OCR. */
  function applyExtracted(data: ExtractedTransaction) {
    const filled: string[] = [];
    if (data.amount) { setAmount(String(data.amount)); filled.push('amount'); }
    if (data.date) { setDate(data.date.slice(0, 10)); filled.push('date'); }
    if (data.reference) { setReference(data.reference); filled.push('reference'); }
    if (data.description) { setDescription(data.description); filled.push('note'); }

    // Match the counterparty (whoever we paid) to a supplier first, then a broker.
    const matchName = data.matchedPartyName ?? data.counterpartyName;
    if (matchName) {
      const key = nameKey(matchName);
      const looseEq = (n: string) => { const k = nameKey(n); return k !== '' && (k === key || k.includes(key) || key.includes(k)); };
      const supplier = suppliers.find((s) => nameKey(s.name) === key) ?? suppliers.find((s) => looseEq(s.name));
      if (supplier) {
        setType('SUPPLIER'); setPartyId(supplier.id); setBrokerId('');
        filled.push(supplier.name);
      } else {
        const broker = brokers?.find((b) => nameKey(b.name) === key) ?? brokers?.find((b) => looseEq(b.name));
        if (broker) {
          setType('BROKER'); setBrokerId(broker.id); setPartyId('');
          filled.push(broker.name);
        } else {
          // Unknown recipient → keep it as a free-text payee on an expense payment.
          setPayee(matchName);
          filled.push(matchName);
        }
      }
    }

    if (filled.length) toast.success(`Read: ${filled.join(', ')}. Verify and record.`);
    else toast.message('Could not read the screenshot. Enter details manually.');
  }

  const mutation = useMutation({
    mutationFn: () => {
      const fields = {
        date,
        amount: Number(amount) || 0,
        type,
        partyId: (type === 'SUPPLIER' || type === 'HAMALI') ? partyId || null : null,
        brokerId: type === 'BROKER' ? brokerId || null : null,
        lorryNumber: (type === 'TRANSPORTER_INWARD' || type === 'TRANSPORTER_OUTWARD') ? lorryNumber || null : null,
        payee: !COUNTERPARTY_TYPES.includes(type) ? payee || null : null,
        reference: reference || null,
        description: description || null,
      };
      // With a proof screenshot the create goes multipart so the server can
      // persist the file and WhatsApp it to the party; otherwise plain JSON.
      if (screenshotFile) {
        const fd = new FormData();
        for (const [k, v] of Object.entries(fields)) {
          if (v !== null && v !== undefined) fd.append(k, String(v));
        }
        fd.append('screenshot', screenshotFile);
        return api<Payment>('/payments', { method: 'POST', body: fd, multipart: true });
      }
      return api<Payment>('/payments', { method: 'POST', body: fields });
    },
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
    (type !== 'HAMALI' || partyId) &&
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
        <div className="flex items-center gap-2">
          <ExportButtons
            filename="Payments"
            title="Payments Register"
            subtitle={`${total} payment(s)`}
            columns={PAYMENT_EXPORT_COLUMNS}
            rows={() => api<Payment[]>('/payments?all=true')}
          />
          <Button onClick={() => { resetForm(); setOpen(true); }}>
            <Plus className="h-4 w-4" /> Record Payment
          </Button>
        </div>
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
            {!isLoading && total === 0 && (
              <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">No payments recorded yet.</TableCell></TableRow>
            )}
            {visiblePayments.map((p) => {
              const typeLabel = PAYMENT_TYPES.find((t) => t.value === p.type)?.label ?? p.type;
              const managedIn = MANAGED_ELSEWHERE[p.type];
              let paidToText = '-';
              if (p.type === 'SUPPLIER' || p.type === 'HAMALI') {
                paidToText = p.party?.name ?? '-';
              } else if (p.type === 'BROKER') {
                paidToText = p.broker?.name ?? '-';
              } else if (p.type === 'TRANSPORTER_INWARD' || p.type === 'TRANSPORTER_OUTWARD') {
                paidToText = p.lorryNumber ? `Transporter (Lorry ${p.lorryNumber})` : 'Transporter';
              } else {
                paidToText = p.payee || typeLabel;
              }

              return (
                <TableRow key={p.id}>
                  <TableCell>{shortDate(p.date)}</TableCell>
                  <TableCell className="font-semibold text-xs text-muted-foreground">
                    {typeLabel}
                    {managedIn && <span className="ml-1.5 font-normal italic text-[10px]">· via {managedIn}</span>}
                  </TableCell>
                  <TableCell className="font-medium">{paidToText}</TableCell>
                  <TableCell className="font-mono text-xs">{p.reference ?? '-'}</TableCell>
                  <TableCell className="max-w-xs truncate text-muted-foreground">{p.description ?? '-'}</TableCell>
                  <TableCell className="text-right font-bold text-rose-600 dark:text-rose-400">{rupees(p.amount)}</TableCell>
                  <TableCell className="text-right">
                    {managedIn ? (
                      <span className="text-[10px] text-muted-foreground pr-1" title={`Delete this on the ${managedIn}`}>—</span>
                    ) : (
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
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <PaginationBar page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalPages={totalPages} total={total} />
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Record Payment</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <ScreenshotUpload
              endpoint="/payments/extract"
              hint="Drop a payment screenshot to auto-fill"
              onExtracted={applyExtracted}
              onFile={setScreenshotFile}
            />

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
              <Select value={type} onValueChange={(val: any) => { setType(val); setPartyId(''); setBrokerId(''); setLorryNumber(''); setPayee(''); }}>
                <SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger>
                <SelectContent>
                  {PAYMENT_TYPE_GROUPS.map((g) => (
                    <SelectGroup key={g.label}>
                      <SelectLabel>{g.label}</SelectLabel>
                      {g.items.map((t) => (
                        <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {(type === 'SUPPLIER' || type === 'HAMALI') && (
              <div className="space-y-2">
                <Label>{type === 'HAMALI' ? 'Hamali Team' : 'Supplier'}</Label>
                <Select value={partyId} onValueChange={setPartyId}>
                  <SelectTrigger><SelectValue placeholder={type === 'HAMALI' ? 'Select hamali team' : 'Select supplier'} /></SelectTrigger>
                  <SelectContent>
                    {(type === 'HAMALI' ? hamaliTeams : suppliers).map((s) => (
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

            {type === 'TRANSPORT' && (
              <div className="space-y-2">
                <Label htmlFor="lorry">Lorry / Vehicle Number</Label>
                <Input id="lorry" value={lorryNumber} onChange={(e) => setLorryNumber(e.target.value)} placeholder="e.g. AP02AB1234" />
                <p className="text-[10px] text-muted-foreground">Required to match freight charges to the corresponding vehicle.</p>
              </div>
            )}

            {!COUNTERPARTY_TYPES.includes(type) && (
              <div className="space-y-2">
                <Label htmlFor="payee">Paid To / Payee</Label>
                <Input id="payee" value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="e.g. Shabri Reddy, APSPDCL, labour contractor" />
                <p className="text-[10px] text-muted-foreground">Optional — the person or party who received this payment.</p>
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
