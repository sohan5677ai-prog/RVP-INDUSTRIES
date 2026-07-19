import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { PaginationBar } from '@/components/ui/pagination-bar';
import { ScreenshotUpload, nameKey, type ExtractedTransaction } from '@/components/ScreenshotUpload';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';
import type { Receipt, Party, ReceiptType, SaleOrder } from '@/lib/types';
import { rupees, shortDate } from '@/lib/format';
import { invalidateReceiptQueries } from '@/lib/receiptCache';
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

// Types you can record directly from this page. Gunny Bag Sales are entered on
// the Gunny Bags page (which auto-posts a linked Receipt here), so it is
// intentionally absent from this form.
const RECEIPT_TYPE_GROUPS: { label: string; items: { value: ReceiptType; label: string }[] }[] = [
  {
    label: 'Buyers',
    items: [
      { value: 'BUYER', label: 'Buyer Collection' },
    ],
  },
  {
    label: 'Income',
    items: [
      { value: 'SCRAP_SALE', label: 'Scrap / Waste Sales' },
      { value: 'HAMALI_INCOME', label: 'Hamali Income' },
      { value: 'INTEREST_INCOME', label: 'Interest Income' },
    ],
  },
  {
    label: 'Other',
    items: [
      { value: 'OTHER', label: 'Other Receipt / Revenue' },
    ],
  },
];

// Full label map for rendering ANY receipt in the table, including ones
// auto-created from a detail page (not offered in the form above).
const RECEIPT_TYPES: { value: ReceiptType; label: string }[] = [
  ...RECEIPT_TYPE_GROUPS.flatMap((g) => g.items),
  { value: 'GUNNY_BAGS_SALE', label: 'Gunny Bag Sales' },
];

// Types that settle a specific buyer (they have their own picker below).
// Everything else is a direct-cash income that uses the free-text payer.
const COLLECTION_TYPES: ReceiptType[] = ['BUYER'];

// Sentinel for the "no specific invoice" option in the invoice picker (shadcn
// Select can't use an empty-string value).
const NO_INVOICE = '__none__';

/** One of a buyer's outstanding invoiced shipments, for the receipt picker. */
interface BuyerInvoice {
  id: string;            // saleDispatch id
  invoiceNumber: string | null;
  billAmount: number;    // billed total (base + GST), whole rupees
  remaining: number;     // still due after prior receipts (FIFO), whole rupees
  shortageStored: number; // ₹ shortage recorded from the buyer's kata at delivery
}

// Receipts created from a detail page (currently only Gunny Bag sales).
// Read-only here — delete them on their own page so both sides stay in sync.
const MANAGED_ELSEWHERE: Partial<Record<ReceiptType, string>> = {
  GUNNY_BAGS_SALE: 'Gunny Bags page',
};

function receiptTypeLabel(r: Receipt): string {
  return RECEIPT_TYPES.find((t) => t.value === r.type)?.label ?? r.type;
}

function receiptReceivedFrom(r: Receipt): string {
  if (r.type === 'BUYER') return r.party?.name ?? '-';
  return r.payer || receiptTypeLabel(r);
}

const RECEIPT_EXPORT_COLUMNS: ExportColumn<Receipt>[] = [
  { header: 'Date', value: (r) => shortDate(r.date) },
  { header: 'Type', value: (r) => receiptTypeLabel(r) },
  { header: 'Received From', value: (r) => receiptReceivedFrom(r) },
  { header: 'Ref / Cheque', value: (r) => r.reference ?? '' },
  { header: 'Description', value: (r) => r.description ?? '' },
  { header: 'Amount', value: (r) => rupees(r.amount), excel: (r) => Number(r.amount), numFmt: '#,##0.00', align: 'right' },
];

export default function ReceiptsPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  // Server-side pagination: only the visible page loads, so the page opens fast
  // however long the receipt history grows. "All" and Export still pull the full
  // set on demand.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(50);
  useEffect(() => { setPage(1); }, [pageSize]);

  const { data: pageData, isLoading } = useQuery({
    queryKey: ['receipts', { page, pageSize }],
    queryFn: () =>
      pageSize === Infinity
        ? api<Receipt[]>('/receipts?all=true').then((rows) => ({ rows, total: rows.length }))
        : api<{ rows: Receipt[]; total: number }>(`/receipts?skip=${(page - 1) * pageSize}&take=${pageSize}`),
    placeholderData: keepPreviousData,
  });
  const visibleReceipts = pageData?.rows ?? [];
  const total = pageData?.total ?? 0;
  const totalPages = pageSize === Infinity ? 1 : Math.max(1, Math.ceil(total / pageSize));

  const { data: parties } = useQuery({
    queryKey: ['parties'],
    queryFn: () => api<Party[]>('/parties'),
  });

  const buyers = parties?.filter((p) => p.type === 'BUYER') ?? [];

  // Form State
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState('');
  const [type, setType] = useState<ReceiptType>('BUYER');
  const [partyId, setPartyId] = useState('');
  const [payer, setPayer] = useState('');
  const [reference, setReference] = useState('');
  const [description, setDescription] = useState('');
  const [saleDispatchId, setSaleDispatchId] = useState('');
  const [shortage, setShortage] = useState('');

  // Outstanding-invoice data — only pulled while the dialog is open, so the
  // register itself stays fast. Sale orders carry the buyer-kata shortage
  // (creditNoteAmount) recorded at delivery; receipts let us net off prior
  // collections so fully-paid invoices drop out of the picker.
  const { data: allSaleOrders } = useQuery({
    queryKey: ['sale-orders', { all: true }],
    queryFn: () => api<SaleOrder[]>('/sale-orders?all=true'),
    enabled: open,
  });
  const { data: allReceipts } = useQuery({
    queryKey: ['receipts', { all: true }],
    queryFn: () => api<Receipt[]>('/receipts?all=true'),
    enabled: open,
  });

  // FIFO outstanding for the selected buyer, mirroring the Sale Dues page:
  // direct (invoice-tagged) receipts settle their own shipment first, then any
  // unallocated buyer receipts flow oldest-invoice-first. TDS + shortage count
  // as clearing amounts, same as there.
  const buyerInvoices = useMemo<BuyerInvoice[]>(() => {
    if (type !== 'BUYER' || !partyId) return [];
    const shipments = (allSaleOrders ?? [])
      .filter((o) => o.buyerId === partyId)
      .flatMap((o) => (o.dispatches ?? []).map((d) => ({ d, o })))
      .sort((a, z) => new Date(a.d.dispatchDate).getTime() - new Date(z.d.dispatchDate).getTime())
      .map(({ d, o }) => {
        const total = Math.round(Number(d.weightKg) * Number(o.ratePerKg) + (Number(d.gstAmount) || 0));
        return { d, remaining: total, billAmount: total };
      });

    const buyerReceipts = (allReceipts ?? [])
      .filter((r) => r.type === 'BUYER' && r.partyId === partyId)
      .sort((a, z) => new Date(a.date).getTime() - new Date(z.date).getTime());
    const clearing = (r: Receipt) => Number(r.amount) + Number(r.tdsAmount ?? 0) + Number(r.shortageAmount ?? 0);

    shipments.forEach((s) => {
      buyerReceipts.filter((r) => r.saleDispatchId === s.d.id).forEach((r) => {
        if (s.remaining > 0) s.remaining -= Math.min(clearing(r), s.remaining);
      });
    });
    const pool = buyerReceipts.filter((r) => !r.saleDispatchId).map((r) => ({ available: clearing(r) }));
    shipments.forEach((s) => {
      for (const r of pool) {
        if (s.remaining <= 0) break;
        if (r.available > 0) { const ap = Math.min(r.available, s.remaining); r.available -= ap; s.remaining -= ap; }
      }
    });

    return shipments
      .filter((s) => s.remaining > 0.5)
      .map((s) => ({
        id: s.d.id,
        invoiceNumber: s.d.invoiceNumber,
        billAmount: s.billAmount,
        remaining: Math.round(s.remaining),
        shortageStored: Math.round(Number(s.d.creditNoteAmount) || 0),
      }));
  }, [type, partyId, allSaleOrders, allReceipts]);

  function resetForm() {
    setDate(new Date().toISOString().slice(0, 10));
    setAmount('');
    setType('BUYER');
    setPartyId('');
    setPayer('');
    setReference('');
    setDescription('');
    setSaleDispatchId('');
    setShortage('');
  }

  /** Pick an invoice to settle → tie the receipt to it and auto-fill the
   *  recorded kata shortage + the net cash still expected. */
  function selectInvoice(v: string) {
    if (v === NO_INVOICE) { setSaleDispatchId(''); setShortage(''); return; }
    setSaleDispatchId(v);
    const inv = buyerInvoices.find((i) => i.id === v);
    if (inv) {
      setShortage(inv.shortageStored > 0 ? String(inv.shortageStored) : '');
      setAmount(String(Math.max(0, inv.remaining - inv.shortageStored)));
    }
  }

  /** Pre-fill the form from a receipt screenshot read by the server OCR. */
  function applyExtracted(data: ExtractedTransaction) {
    const filled: string[] = [];
    if (data.amount) { setAmount(String(data.amount)); filled.push('amount'); }
    if (data.date) { setDate(data.date.slice(0, 10)); filled.push('date'); }
    if (data.reference) { setReference(data.reference); filled.push('reference'); }
    if (data.description) { setDescription(data.description); filled.push('note'); }

    // Match the counterparty (whoever paid us) to a known buyer.
    const matchName = data.matchedPartyName ?? data.counterpartyName;
    if (matchName) {
      const key = nameKey(matchName);
      const buyer = buyers.find((b) => nameKey(b.name) === key)
        ?? buyers.find((b) => { const k = nameKey(b.name); return k !== '' && (k.includes(key) || key.includes(k)); });
      if (buyer) {
        setType('BUYER'); setPartyId(buyer.id);
        filled.push(buyer.name);
      } else {
        // Unknown payer → keep it as free text on a direct-income receipt.
        setPayer(matchName);
        filled.push(matchName);
      }
    }

    if (filled.length) toast.success(`Read: ${filled.join(', ')}. Verify and record.`);
    else toast.message('Could not read the screenshot. Enter details manually.');
  }

  const mutation = useMutation({
    mutationFn: () =>
      api<Receipt>('/receipts', {
        method: 'POST',
        body: {
          date,
          amount: Number(amount) || 0,
          type,
          partyId: type === 'BUYER' ? partyId || null : null,
          saleDispatchId: type === 'BUYER' && saleDispatchId ? saleDispatchId : null,
          shortageAmount: type === 'BUYER' ? (Number(shortage) || 0) : 0,
          payer: !COLLECTION_TYPES.includes(type) ? payer || null : null,
          reference: reference || null,
          description: description || null,
        },
      }),
    onSuccess: () => {
      invalidateReceiptQueries(qc);
      toast.success('Receipt recorded successfully');
      setOpen(false);
      resetForm();
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/receipts/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidateReceiptQueries(qc);
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
        <div className="flex items-center gap-2">
          <ExportButtons
            filename="Receipts"
            title="Receipts Register"
            subtitle={`${total} receipt(s)`}
            columns={RECEIPT_EXPORT_COLUMNS}
            rows={() => api<Receipt[]>('/receipts?all=true')}
          />
          <Button onClick={() => { resetForm(); setOpen(true); }}>
            <Plus className="h-4 w-4" /> Record Receipt
          </Button>
        </div>
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
            {!isLoading && total === 0 && (
              <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">No receipts recorded yet.</TableCell></TableRow>
            )}
            {visibleReceipts.map((r) => {
              const typeLabel = RECEIPT_TYPES.find((t) => t.value === r.type)?.label ?? r.type;
              const managedIn = MANAGED_ELSEWHERE[r.type];
              let receivedFromText = '-';
              if (r.type === 'BUYER') {
                receivedFromText = r.party?.name ?? '-';
              } else {
                receivedFromText = r.payer || typeLabel;
              }

              return (
                <TableRow key={r.id}>
                  <TableCell>{shortDate(r.date)}</TableCell>
                  <TableCell className="font-semibold text-xs text-muted-foreground">
                    {typeLabel}
                    {managedIn && <span className="ml-1.5 font-normal italic text-[10px]">· via {managedIn}</span>}
                  </TableCell>
                  <TableCell className="font-medium">{receivedFromText}</TableCell>
                  <TableCell className="font-mono text-xs">{r.reference ?? '-'}</TableCell>
                  <TableCell className="max-w-xs truncate text-muted-foreground">{r.description ?? '-'}</TableCell>
                  <TableCell className="text-right font-bold text-emerald-600 dark:text-emerald-400">{rupees(r.amount)}</TableCell>
                  <TableCell className="text-right">
                    {managedIn ? (
                      <span className="text-[10px] text-muted-foreground pr-1" title={`Delete this on the ${managedIn}`}>—</span>
                    ) : (
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
            <DialogTitle>Record Receipt</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <ScreenshotUpload
              endpoint="/receipts/extract"
              hint="Drop a receipt screenshot to auto-fill"
              onExtracted={applyExtracted}
            />

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
              <Select value={type} onValueChange={(val: any) => { setType(val); setPartyId(''); setPayer(''); setSaleDispatchId(''); setShortage(''); }}>
                <SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger>
                <SelectContent>
                  {RECEIPT_TYPE_GROUPS.map((g) => (
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

            {type === 'BUYER' && (
              <div className="space-y-2">
                <Label>Buyer</Label>
                <Select value={partyId} onValueChange={(v) => { setPartyId(v); setSaleDispatchId(''); setShortage(''); }}>
                  <SelectTrigger><SelectValue placeholder="Select buyer" /></SelectTrigger>
                  <SelectContent>
                    {buyers.map((b) => (
                      <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {type === 'BUYER' && partyId && (
              <div className="space-y-2">
                <Label>Against Invoice (optional)</Label>
                <Select value={saleDispatchId || NO_INVOICE} onValueChange={selectInvoice}>
                  <SelectTrigger><SelectValue placeholder="Unallocated" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_INVOICE}>Unallocated (no specific invoice)</SelectItem>
                    {buyerInvoices.map((inv) => (
                      <SelectItem key={inv.id} value={inv.id}>
                        {inv.invoiceNumber ?? 'No invoice'} · due {rupees(inv.remaining)}
                        {inv.shortageStored > 0 ? ` · shortage ${rupees(inv.shortageStored)}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {buyerInvoices.length === 0 && (
                  <p className="text-[10px] text-muted-foreground">No outstanding invoices for this buyer.</p>
                )}
              </div>
            )}

            {type === 'BUYER' && (
              <div className="space-y-2">
                <Label htmlFor="shortage">Shortage / Kata Deduction (₹)</Label>
                <Input id="shortage" type="number" step="1" value={shortage} onChange={(e) => setShortage(e.target.value)} placeholder="0" />
                <p className="text-[10px] text-muted-foreground">Auto-filled from the buyer's kata shortage recorded at delivery. Adjust if needed.</p>
              </div>
            )}

            {!COLLECTION_TYPES.includes(type) && (
              <div className="space-y-2">
                <Label htmlFor="payer">Received From / Payer</Label>
                <Input id="payer" value={payer} onChange={(e) => setPayer(e.target.value)} placeholder="e.g. gunny bag buyer, scrap dealer" />
                <p className="text-[10px] text-muted-foreground">Optional — the person or party this money came from.</p>
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
