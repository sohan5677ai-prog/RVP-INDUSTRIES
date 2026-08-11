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
import { shortageWithGst, saleTds, round2 } from '@/lib/receiptCalc';
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
  { value: 'OTHER_INCOME', label: 'Other Income' },
];

// Types that settle a specific buyer (they have their own picker below).
// Everything else is a direct-cash income that uses the free-text payer.
const COLLECTION_TYPES: ReceiptType[] = ['BUYER'];

/** One of a buyer's outstanding invoiced shipments, for the receipt picker. */
interface BuyerInvoice {
  id: string;            // saleDispatch id
  invoiceNumber: string | null;
  billDate: string;
  billAmount: number;    // billed total (base + GST), whole rupees
  remaining: number;     // still due after receipts linked to THIS invoice, whole rupees
  saleBase: number;      // sale value EXCLUDING GST - the TDS calc base
  shortageBase: number;  // buyer-kata shortage goods value (GST-excluded) at delivery
  gstExempt: boolean;    // whether 5% GST applies to the shortage deduction
}

/** What one invoice takes out of a single collection. Shortage is held as the
 *  GST-EXCLUDED goods value; the 5% is added when the receipt is posted. */
interface Allocation {
  cash: string;
  tds: string;
  shortage: string;
}

const EMPTY_ALLOC: Allocation = { cash: '', tds: '', shortage: '' };
const num = (s: string) => Number(s) || 0;

// Receipts created from a detail page (Gunny Bag sales, Other Income).
// Read-only here - delete them on their own page so both sides stay in sync.
const MANAGED_ELSEWHERE: Partial<Record<ReceiptType, string>> = {
  GUNNY_BAGS_SALE: 'Gunny Bags page',
  OTHER_INCOME: 'Other Income page',
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

  // BOTH counts as a buyer here (byproduct customers are often suppliers too),
  // otherwise their invoices can't be settled from this page.
  const buyers = parties?.filter((p) => p.type === 'BUYER' || p.type === 'BOTH') ?? [];

  // Form State
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState('');
  const [type, setType] = useState<ReceiptType>('BUYER');
  const [partyId, setPartyId] = useState('');
  const [payer, setPayer] = useState('');
  const [reference, setReference] = useState('');
  const [description, setDescription] = useState('');
  // Invoice-wise split of this collection, keyed by saleDispatch id. Empty =
  // nothing allocated (only allowed when the buyer has no open invoices).
  const [allocs, setAllocs] = useState<Record<string, Allocation>>({});
  const [enableTds, setEnableTds] = useState(false);

  // Outstanding-invoice data - only pulled while the dialog is open, so the
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

  // Outstanding invoices for the selected buyer. Settlement is invoice-based
  // ONLY - exactly as on Sale Dues and the product sales pages: a shipment is
  // cleared purely by the receipts stamped with its own dispatch id. Receipts
  // sitting on account clear nothing here, which is precisely why they must be
  // allocated rather than left floating.
  const buyerInvoices = useMemo<BuyerInvoice[]>(() => {
    if (type !== 'BUYER' || !partyId) return [];
    const linked = new Map<string, number>();
    for (const r of allReceipts ?? []) {
      if (r.type !== 'BUYER' || !r.saleDispatchId) continue;
      const clearing = Number(r.amount) + Number(r.tdsAmount ?? 0) + Number(r.shortageAmount ?? 0);
      linked.set(r.saleDispatchId, (linked.get(r.saleDispatchId) ?? 0) + clearing);
    }

    return (allSaleOrders ?? [])
      .filter((o) => o.buyerId === partyId)
      .flatMap((o) => (o.dispatches ?? []).map((d) => ({ d, o })))
      .sort((a, z) => new Date(a.d.dispatchDate).getTime() - new Date(z.d.dispatchDate).getTime())
      .map(({ d, o }) => {
        const rate = Number(o.ratePerKg);
        const total = Math.round(Number(d.weightKg) * rate + (Number(d.gstAmount) || 0));
        return {
          id: d.id,
          invoiceNumber: d.invoiceNumber,
          billDate: d.dispatchDate,
          billAmount: total,
          remaining: Math.round(Math.max(0, total - (linked.get(d.id) ?? 0))),
          saleBase: Number(d.weightKg) * rate,
          shortageBase: (Number(d.shortageKg) || 0) * rate,
          gstExempt: o.gstExempt,
        };
      })
      .filter((s) => s.remaining > 0.5);
  }, [type, partyId, allSaleOrders, allReceipts]);

  function resetForm() {
    setDate(new Date().toISOString().slice(0, 10));
    setAmount('');
    setType('BUYER');
    setPartyId('');
    setPayer('');
    setReference('');
    setDescription('');
    setAllocs({});
    setEnableTds(false);
  }

  /** Cash expected on one invoice = its balance − shortage(base + 5% GST) − TDS.
   *  Both deductions come OFF the cash, never on top of it. */
  function expectedCash(inv: BuyerInvoice, shortageStr: string, tdsStr: string, tdsOn: boolean) {
    const shortageTotal = shortageWithGst(parseFloat(shortageStr) || 0, inv.gstExempt);
    const tds = tdsOn ? (parseFloat(tdsStr) || 0) : 0;
    return String(round2(Math.max(0, inv.remaining - shortageTotal - tds)));
  }

  /** Prefilled split for one invoice: its recorded kata shortage, TDS when the
   *  toggle is on, and the net cash still expected. Same maths as the Sale Dues
   *  and "Mark as Paid" dialogs. */
  function defaultAlloc(inv: BuyerInvoice, tdsOn: boolean): Allocation {
    const shortage = inv.shortageBase > 0 ? String(round2(inv.shortageBase)) : '';
    const tds = String(saleTds(inv.saleBase));
    return { shortage, tds, cash: expectedCash(inv, shortage, tds, tdsOn) };
  }

  /** Tick / untick an invoice on this collection. */
  function toggleInvoice(inv: BuyerInvoice, on: boolean) {
    setAllocs((prev) => {
      const next = { ...prev };
      if (on) next[inv.id] = defaultAlloc(inv, enableTds);
      else delete next[inv.id];
      return next;
    });
  }

  function patchAlloc(inv: BuyerInvoice, patch: Partial<Allocation>) {
    setAllocs((prev) => {
      const cur = prev[inv.id] ?? EMPTY_ALLOC;
      const merged = { ...cur, ...patch };
      // Editing a deduction re-derives the cash; editing cash is left alone.
      if (patch.cash === undefined && (patch.tds !== undefined || patch.shortage !== undefined)) {
        merged.cash = expectedCash(inv, merged.shortage, merged.tds, enableTds);
      }
      return { ...prev, [inv.id]: merged };
    });
  }

  /** TDS applies to the whole collection, so the toggle re-derives every row. */
  function toggleTds(on: boolean) {
    setEnableTds(on);
    setAllocs((prev) => {
      const next: Record<string, Allocation> = {};
      for (const [id, a] of Object.entries(prev)) {
        const inv = buyerInvoices.find((i) => i.id === id);
        if (!inv) { next[id] = a; continue; }
        const tds = a.tds || String(saleTds(inv.saleBase));
        next[id] = { ...a, tds, cash: expectedCash(inv, a.shortage, tds, on) };
      }
      return next;
    });
  }

  const allocatedIds = Object.keys(allocs);
  const allocatedCash = allocatedIds.reduce((s, id) => s + num(allocs[id].cash), 0);
  const allocatedTds = enableTds ? allocatedIds.reduce((s, id) => s + num(allocs[id].tds), 0) : 0;
  const allocatedShortage = allocatedIds.reduce((s, id) => s + num(allocs[id].shortage), 0);
  const allocatedShortageGross = allocatedIds.reduce((s, id) => {
    const inv = buyerInvoices.find((i) => i.id === id);
    return s + shortageWithGst(num(allocs[id].shortage), inv?.gstExempt ?? false);
  }, 0);
  const allocatedTotal = round2(allocatedCash + allocatedTds + allocatedShortageGross);

  // With invoices ticked the amount received IS the sum of their cash shares, so
  // the two can never drift apart (the server rejects a mismatch anyway).
  useEffect(() => {
    if (allocatedIds.length > 0) setAmount(String(round2(allocatedCash)));
  }, [allocatedCash, allocatedIds.length]);

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
          payer: !COLLECTION_TYPES.includes(type) ? payer || null : null,
          reference: reference || null,
          description: description || null,
          // One row per invoice, so every rupee clears a specific bill instead of
          // sitting on account where the dues pages can't see it. Shortage clears
          // the GST-inclusive invoice → book base + 5% GST on it.
          allocations: allocatedIds.map((id) => {
            const inv = buyerInvoices.find((i) => i.id === id);
            const a = allocs[id];
            return {
              saleDispatchId: id,
              amount: round2(num(a.cash)),
              tdsAmount: enableTds ? round2(num(a.tds)) : 0,
              shortageAmount: shortageWithGst(num(a.shortage), inv?.gstExempt ?? false),
            };
          }),
        },
      }),
    onSuccess: () => {
      invalidateReceiptQueries(qc);
      toast.success(
        allocatedIds.length > 1
          ? `Receipt recorded against ${allocatedIds.length} invoices`
          : 'Receipt recorded successfully',
      );
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

  // A buyer collection with open invoices MUST say which ones it settles.
  // Leaving it unallocated credits the party ledger but clears no invoice, so
  // the bill keeps showing Unpaid on Sale Dues and the statement prints a
  // receipt with no invoice against it - the exact mismatch this blocks.
  const needsAllocation = type === 'BUYER' && !!partyId && buyerInvoices.length > 0;
  const isValid =
    Number(amount) > 0 &&
    (type !== 'BUYER' || partyId) &&
    (!needsAllocation || allocatedIds.length > 0);

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
                  <TableCell className="font-medium">
                    {receivedFromText}
                    {/* Money that credited the ledger but cleared no bill - the
                        invoice stays Unpaid on Sale Dues until it is re-recorded
                        against one. */}
                    {r.type === 'BUYER' && !r.saleDispatchId && (
                      <span
                        className="ml-2 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-950/60 dark:text-amber-400"
                        title="Not applied to any invoice - reverse it and re-record it against the invoices it settles"
                      >
                        On account
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.reference ?? '-'}</TableCell>
                  <TableCell className="max-w-xs truncate text-muted-foreground">{r.description ?? '-'}</TableCell>
                  <TableCell className="text-right font-bold text-emerald-600 dark:text-emerald-400">{rupees(r.amount)}</TableCell>
                  <TableCell className="text-right">
                    {managedIn ? (
                      <span className="text-[10px] text-muted-foreground pr-1" title={`Delete this on the ${managedIn}`}>-</span>
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
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
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
                <Input
                  id="amount"
                  type="number"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="e.g. 100000"
                  readOnly={allocatedIds.length > 0}
                  className={allocatedIds.length > 0 ? 'bg-muted/60' : undefined}
                />
                {allocatedIds.length > 0 && (
                  <p className="text-[10px] text-muted-foreground">Sum of the cash allocated below.</p>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <Label>Receipt Type</Label>
              <Select value={type} onValueChange={(val: any) => { setType(val); setPartyId(''); setPayer(''); setAllocs({}); setEnableTds(false); }}>
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
                <Select value={partyId} onValueChange={(v) => { setPartyId(v); setAllocs({}); setEnableTds(false); }}>
                  <SelectTrigger><SelectValue placeholder="Select buyer" /></SelectTrigger>
                  <SelectContent>
                    {buyers.map((b) => (
                      <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Bill-wise allocation. One transfer routinely covers several
                invoices, and settlement everywhere else is invoice-based, so the
                collection is split here rather than left sitting on account. */}
            {type === 'BUYER' && partyId && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <Label>Settle Against Invoices</Label>
                  {buyerInvoices.length > 0 && (
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-primary"
                        checked={enableTds}
                        onChange={(e) => toggleTds(e.target.checked)}
                      />
                      <span className="text-xs font-medium">Deduct TDS (0.1%)</span>
                    </label>
                  )}
                </div>

                {buyerInvoices.length === 0 ? (
                  <p className="text-[10px] text-muted-foreground">
                    No outstanding invoices for this buyer - this will be recorded as an advance / on-account receipt.
                  </p>
                ) : (
                  <>
                    <div className="rounded-md border overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead className="bg-muted/60 text-muted-foreground">
                          <tr>
                            <th className="w-8 p-2" />
                            <th className="p-2 text-left font-medium">Invoice</th>
                            <th className="p-2 text-right font-medium">Due</th>
                            <th className="p-2 text-right font-medium">Cash</th>
                            {enableTds && <th className="p-2 text-right font-medium">TDS</th>}
                            <th className="p-2 text-right font-medium">Shortage</th>
                            <th className="p-2 text-right font-medium">Balance</th>
                          </tr>
                        </thead>
                        <tbody>
                          {buyerInvoices.map((inv) => {
                            const a = allocs[inv.id];
                            const on = !!a;
                            const cleared = on
                              ? num(a.cash) + (enableTds ? num(a.tds) : 0) + shortageWithGst(num(a.shortage), inv.gstExempt)
                              : 0;
                            const balance = round2(inv.remaining - cleared);
                            return (
                              <tr key={inv.id} className={`border-t ${on ? 'bg-primary/5' : ''}`}>
                                <td className="p-2">
                                  <input
                                    type="checkbox"
                                    className="h-4 w-4 accent-primary"
                                    checked={on}
                                    onChange={(e) => toggleInvoice(inv, e.target.checked)}
                                  />
                                </td>
                                <td className="p-2">
                                  <div className="font-medium">{inv.invoiceNumber ?? 'No invoice'}</div>
                                  <div className="text-[10px] text-muted-foreground">{shortDate(inv.billDate)}</div>
                                </td>
                                <td className="p-2 text-right whitespace-nowrap">{rupees(inv.remaining)}</td>
                                <td className="p-2">
                                  <Input
                                    type="number"
                                    step="1"
                                    className="h-8 w-28 text-right"
                                    disabled={!on}
                                    value={a?.cash ?? ''}
                                    onChange={(e) => patchAlloc(inv, { cash: e.target.value })}
                                  />
                                </td>
                                {enableTds && (
                                  <td className="p-2">
                                    <Input
                                      type="number"
                                      step="1"
                                      className="h-8 w-24 text-right"
                                      disabled={!on}
                                      value={a?.tds ?? ''}
                                      onChange={(e) => patchAlloc(inv, { tds: e.target.value })}
                                    />
                                  </td>
                                )}
                                <td className="p-2">
                                  <Input
                                    type="number"
                                    step="1"
                                    className="h-8 w-24 text-right"
                                    disabled={!on}
                                    placeholder="0"
                                    value={a?.shortage ?? ''}
                                    onChange={(e) => patchAlloc(inv, { shortage: e.target.value })}
                                  />
                                </td>
                                <td className="p-2 text-right whitespace-nowrap">
                                  {!on ? (
                                    <span className="text-muted-foreground">-</span>
                                  ) : Math.abs(balance) < 1 ? (
                                    <span className="font-semibold text-emerald-600 dark:text-emerald-400">Settled</span>
                                  ) : (
                                    <span className="font-medium text-amber-600 dark:text-amber-500">
                                      {balance > 0 ? rupees(balance) : `+${rupees(-balance)}`}
                                    </span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      Tick every invoice this money covers. Shortage is the goods value of the buyer's kata cut
                      (auto-filled from delivery); 5% GST is added on top. Money left unallocated credits the ledger
                      but clears no bill, so the invoice would keep reading Unpaid on Sale Dues.
                    </p>
                  </>
                )}
              </div>
            )}

            {/* Settlement summary - mirrors the "Mark as Paid" / Sale Dues breakdown */}
            {type === 'BUYER' && allocatedIds.length > 0 && (
              <div className="rounded-md bg-muted/50 px-3 py-2 text-xs space-y-0.5">
                <div className="flex justify-between">
                  <span>Invoices settled</span><span>{allocatedIds.length}</span>
                </div>
                <div className="flex justify-between"><span>Cash received</span><span>{rupees(allocatedCash)}</span></div>
                {allocatedShortage > 0 && (
                  <>
                    <div className="flex justify-between text-amber-600 dark:text-amber-500">
                      <span>Shortage</span><span>{rupees(allocatedShortage)}</span>
                    </div>
                    <div className="flex justify-between text-amber-600 dark:text-amber-500">
                      <span>GST on shortage (5%)</span><span>{rupees(allocatedShortageGross - allocatedShortage)}</span>
                    </div>
                  </>
                )}
                {allocatedTds > 0 && (
                  <div className="flex justify-between text-amber-600 dark:text-amber-500">
                    <span>TDS (0.1%)</span><span>{rupees(allocatedTds)}</span>
                  </div>
                )}
                <div className="flex justify-between font-semibold border-t pt-1 mt-1">
                  <span>Total cleared against invoices</span><span>{rupees(allocatedTotal)}</span>
                </div>
              </div>
            )}

            {needsAllocation && allocatedIds.length === 0 && (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
                This buyer has {buyerInvoices.length} outstanding invoice{buyerInvoices.length === 1 ? '' : 's'}.
                Tick the ones this payment settles - a receipt with no invoice clears nothing.
              </p>
            )}

            {!COLLECTION_TYPES.includes(type) && (
              <div className="space-y-2">
                <Label htmlFor="payer">Received From / Payer</Label>
                <Input id="payer" value={payer} onChange={(e) => setPayer(e.target.value)} placeholder="e.g. gunny bag buyer, scrap dealer" />
                <p className="text-[10px] text-muted-foreground">Optional - the person or party this money came from.</p>
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
