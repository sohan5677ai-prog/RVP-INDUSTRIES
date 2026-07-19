import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { Party, SaleOrder, Receipt, SaleProduct } from '@/lib/types';
import { rupees, shortDate } from '@/lib/format';
import { settledByDispatch, isDispatchPaid, dispatchTotal } from '@/lib/saleStatus';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TrendingUp, Loader2, ChevronDown, ChevronRight, Undo2 } from 'lucide-react';
import { Fragment } from 'react';
import { Segmented } from '@/components/ui/segmented';
import { PaginationBar } from '@/components/ui/pagination-bar';
import { usePagedRows } from '@/lib/usePagedRows';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';

const TDS_RATE = 0.001; // 0.1% of sale value

// Byproducts share one tab group in the Sales nav; group them the same way here.
const BYPRODUCT_PRODUCTS: SaleProduct[] = ['WASTE', 'SHELL', 'PRECLEANER_DUST', 'NALLA_POKKULU', 'NALLA_CHINTAPANDU'];

type ProductFilter = 'ALL' | 'PAPPU' | 'HUSK' | 'TPS' | 'BYPRODUCTS';

const PRODUCT_FILTERS: { value: ProductFilter; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'PAPPU', label: 'Pappu' },
  { value: 'HUSK', label: 'Husk' },
  { value: 'TPS', label: 'TPS (Brokens)' },
  { value: 'BYPRODUCTS', label: 'Tamarind Byproducts' },
];

function matchesProductFilter(product: SaleProduct, filter: ProductFilter): boolean {
  if (filter === 'ALL') return true;
  if (filter === 'BYPRODUCTS') return BYPRODUCT_PRODUCTS.includes(product);
  return product === filter;
}

// Payment-status tabs. "Unpaid" catches anything with even ₹1 still outstanding
// (i.e. both fully-unpaid and partially-paid invoices).
type PayFilter = 'ALL' | 'PAID' | 'UNPAID';

const PAY_FILTERS: { value: PayFilter; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'PAID', label: 'Paid' },
  { value: 'UNPAID', label: 'Unpaid' },
];

interface OutstandingInvoice {
  id: string;
  partyId: string;
  product: SaleProduct;
  brokerName: string | null;
  dueDate: Date;
  partyName: string;
  invoiceNumber: string | null;
  billDate: Date;
  billAmount: number;   // original invoice value (used for TDS calc base)
  discount: number;
  netAmount: number;    // remaining due after FIFO allocation
  totalAmount: number;
  cashReceived: number; // actual cash (excludes TDS/shortage) applied to this invoice
  dueDaysAfter: number;
  status: string;
  appliedReceipts: { date: string; amount: number; isTdsOrShortage?: boolean }[];
  deletableReceiptIds: string[];
}

interface ReceiveDialogState {
  inv: OutstandingInvoice;
  date: string;
  amountReceived: string;
  tdsAmount: string;
  shortageAmount: string;
}

const SALE_DUES_COLUMNS: ExportColumn<OutstandingInvoice>[] = [
  { header: 'Broker', value: (i) => i.brokerName ?? '' },
  { header: 'Due Date', value: (i) => shortDate(i.dueDate.toISOString()) },
  { header: 'Customer', value: (i) => i.partyName },
  { header: 'Product', value: (i) => i.product },
  { header: 'Invoice No', value: (i) => i.invoiceNumber ?? '' },
  { header: 'Bill Date', value: (i) => shortDate(i.billDate.toISOString()) },
  { header: 'Bill Amount', value: (i) => rupees(i.billAmount), excel: (i) => i.billAmount, numFmt: '#,##0.00', align: 'right' },
  { header: 'Cash Received', value: (i) => rupees(i.cashReceived), excel: (i) => i.cashReceived, numFmt: '#,##0.00', align: 'right' },
  { header: 'Net Amount Due', value: (i) => rupees(i.netAmount), excel: (i) => i.netAmount, numFmt: '#,##0.00', align: 'right' },
  { header: 'Status', value: (i) => i.status, align: 'center' },
  { header: 'Due Days', value: (i) => (i.status === 'Paid' ? '' : i.dueDaysAfter), align: 'center' },
];

export default function SaleDuesPage() {
  const qc = useQueryClient();
  const [receiveDialog, setReceiveDialog] = useState<ReceiveDialogState | null>(null);
  const [enableTds, setEnableTds] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [productFilter, setProductFilter] = useState<ProductFilter>('ALL');
  const [payFilter, setPayFilter] = useState<PayFilter>('ALL');

  const { data: parties, isLoading: loadingParties } = useQuery({
    queryKey: ['parties'],
    queryFn: () => api<Party[]>('/parties'),
  });

  const { data: saleOrders, isLoading: loadingSales } = useQuery({
    queryKey: ['sale-orders', { all: true }],
    queryFn: () => api<SaleOrder[]>('/sale-orders?all=true'),
  });

  const { data: receipts, isLoading: loadingReceipts } = useQuery({
    // Full history — dues are matched against every receipt, not just latest 100.
    queryKey: ['receipts', { all: true }],
    queryFn: () => api<Receipt[]>('/receipts?all=true'),
  });

  const receiveMutation = useMutation({
    mutationFn: (body: {
      date: string; amount: number; tdsAmount: number; shortageAmount: number;
      type: string; partyId: string; saleDispatchId?: string;
    }) => api('/receipts', { method: 'POST', body }),
    onSuccess: () => {
      toast.success('Receipt recorded');
      qc.invalidateQueries({ queryKey: ['receipts'] });
      setReceiveDialog(null);
    },
    onError: () => toast.error('Failed to record receipt'),
  });

  const undoMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) {
        await api(`/receipts/${id}`, { method: 'DELETE' });
      }
    },
    onSuccess: () => {
      toast.success('Receipt removed');
      qc.invalidateQueries({ queryKey: ['receipts'] });
    },
    onError: () => toast.error('Failed to remove receipt'),
  });

  const isLoading = loadingParties || loadingSales || loadingReceipts;

  // Settlement is invoice-based ONLY — no FIFO, no on-account spillover. Each
  // shipment is cleared solely by the buyer receipts stamped with its own
  // saleDispatchId, and the Paid decision runs through the SAME shared helpers
  // (settledByDispatch / isDispatchPaid) the Pappu/Husk sales pages use, so the
  // "Mark Paid" button and this page can never disagree. A general receipt with
  // no saleDispatchId clears nothing here. Keyed strictly on the source data so
  // it recomputes only when data changes (not on every keystroke in the dialog).
  const outstandingInvoices = useMemo<OutstandingInvoice[]>(() => {
  const buyers = parties?.filter((p) => p.type === 'BUYER') ?? [];
  const rows: OutstandingInvoice[] = [];
  const today = new Date();

  // Single source of truth for "cleared per dispatch", identical to the sales pages.
  const settled = settledByDispatch(receipts);

  buyers.forEach((b) => {
    const buyerReceipts = receipts?.filter((r) => r.type === 'BUYER' && r.partyId === b.id) ?? [];
    const shipments = (saleOrders ?? [])
      .filter((o) => o.buyerId === b.id)
      .flatMap((o) => (o.dispatches ?? []).map((d) => ({ d, o })));

    shipments.forEach(({ d, o }) => {
      const rate = Number(o.ratePerKg);
      const total = dispatchTotal(d, rate);
      const cleared = settled.get(d.id) ?? 0;

      // Per-receipt detail (for the expandable panel, cash summary, and Undo).
      const linked = buyerReceipts.filter((r) => r.saleDispatchId === d.id);
      let cashReceived = 0;
      const appliedReceipts: OutstandingInvoice['appliedReceipts'] = [];
      const deletableReceiptIds: string[] = [];
      linked.forEach((r) => {
        const cash = Number(r.amount);
        const clearing = cash + Number(r.tdsAmount ?? 0) + Number(r.shortageAmount ?? 0);
        cashReceived += cash;
        deletableReceiptIds.push(r.id);
        appliedReceipts.push({ date: r.date, amount: clearing, isTdsOrShortage: cash === 0 });
      });

      const paid = isDispatchPaid(d, rate, settled);
      const remaining = paid ? 0 : Math.max(0, total - cleared);
      const status = paid ? 'Paid' : cleared > 0.01 ? 'Partially Paid' : 'Unpaid';

      const start = d.deliveredDate || d.dispatchDate;
      const dueDate = new Date(start);
      dueDate.setDate(dueDate.getDate() + (o.dueDays || 0));
      const dueDaysAfter = Math.max(0, Math.ceil((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24)));

      rows.push({
        id: d.id,
        partyId: b.id,
        product: o.product,
        brokerName: o.broker?.name ?? null,
        dueDate,
        partyName: b.name,
        invoiceNumber: d.invoiceNumber,
        billDate: new Date(d.dispatchDate),
        billAmount: total,
        discount: 0,
        netAmount: remaining,
        totalAmount: total,
        cashReceived,
        dueDaysAfter,
        status,
        appliedReceipts,
        deletableReceiptIds,
      });
    });
  });

  rows.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
  return rows;
  }, [parties, saleOrders, receipts]);

  const visibleInvoices = outstandingInvoices.filter((inv) => matchesProductFilter(inv.product, productFilter));

  const totalBillingAll = visibleInvoices.reduce((sum, item) => sum + item.totalAmount, 0);
  const totalReceiptsAll = visibleInvoices.reduce((sum, item) => sum + item.cashReceived, 0);
  const totalOutstanding = visibleInvoices.reduce((sum, item) => sum + item.netAmount, 0);

  // Payment tab: All shows everything (incl. fully paid), Paid shows settled
  // invoices, Unpaid shows anything still carrying a balance (partial or none).
  // (already sorted ascending by due date above; this filter preserves that order.)
  const paidCount = visibleInvoices.filter((inv) => inv.status === 'Paid').length;
  const unpaidCount = visibleInvoices.length - paidCount;
  const dueInvoices = visibleInvoices.filter((inv) => {
    if (payFilter === 'PAID') return inv.status === 'Paid';
    if (payFilter === 'UNPAID') return inv.status !== 'Paid';
    return true;
  });
  const { page, setPage, pageSize, setPageSize, totalPages, total, pageRows } = usePagedRows(dueInvoices, 50);

  function openReceiveDialog(inv: OutstandingInvoice) {
    const today = new Date().toISOString().slice(0, 10);
    const tds = Math.round(inv.billAmount * TDS_RATE); // whole rupees
    setEnableTds(false);
    setReceiveDialog({
      inv,
      date: today,
      amountReceived: String(Math.round(inv.netAmount)),
      tdsAmount: String(tds),
      shortageAmount: '0',
    });
  }

  // Derived: shortage = outstanding - amountReceived - TDS (when short)
  function getAutoShortage(d: ReceiveDialogState): number {
    const received = parseFloat(d.amountReceived) || 0;
    const tds = enableTds ? (parseFloat(d.tdsAmount) || 0) : 0;
    return Math.max(0, d.inv.netAmount - received - tds);
  }

  function submitReceive() {
    if (!receiveDialog) return;
    const received = parseFloat(receiveDialog.amountReceived);
    const tds = enableTds ? (parseFloat(receiveDialog.tdsAmount) || 0) : 0;
    const shortage = parseFloat(receiveDialog.shortageAmount) || 0;
    if (!receiveDialog.date || isNaN(received) || received < 0) {
      toast.error('Please enter a valid date and amount received');
      return;
    }
    if (received === 0 && tds === 0 && shortage === 0) {
      toast.error('At least one of Amount Received, TDS, or Shortage must be non-zero');
      return;
    }
    receiveMutation.mutate({
      date: receiveDialog.date,
      amount: received,
      tdsAmount: tds,
      shortageAmount: shortage,
      type: 'BUYER',
      partyId: receiveDialog.inv.partyId,
      saleDispatchId: receiveDialog.inv.id,
    });
  }

  const autoShortage = receiveDialog ? getAutoShortage(receiveDialog) : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Sale Dues</h1>
          <p className="text-muted-foreground font-medium">Aging list of outstanding buyer sales invoices matching receipts via FIFO allocation.</p>
        </div>
        <ExportButtons
          filename="Sale_Dues"
          title="Sale Dues (Aging)"
          subtitle={`${PRODUCT_FILTERS.find((f) => f.value === productFilter)?.label} · ${PAY_FILTERS.find((f) => f.value === payFilter)?.label} · ${dueInvoices.length} invoice(s)`}
          columns={SALE_DUES_COLUMNS}
          rows={dueInvoices}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          options={PRODUCT_FILTERS}
          value={productFilter}
          onValueChange={setProductFilter}
          size="sm"
        />
        <Segmented
          options={PAY_FILTERS.map((f) => ({
            ...f,
            count: f.value === 'PAID' ? paidCount : f.value === 'UNPAID' ? unpaidCount : undefined,
          }))}
          value={payFilter}
          onValueChange={setPayFilter}
          size="sm"
        />
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card className="bg-card/50 border shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Billed Sales</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{rupees(totalBillingAll)}</div>
              </CardContent>
            </Card>
            <Card className="bg-card/50 border shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Cash Received</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{rupees(totalReceiptsAll)}</div>
              </CardContent>
            </Card>
            <Card className="bg-card/50 border shadow-sm">
              <CardHeader className="pb-2 flex flex-row items-center justify-between">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Net Outstanding Receivables</CardTitle>
                <TrendingUp className="h-4 w-4 text-emerald-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{rupees(totalOutstanding)}</div>
              </CardContent>
            </Card>
          </div>

          <div className="rounded-lg border bg-card overflow-auto max-h-[70vh]">
            <div className="px-5 py-4 border-b font-semibold text-sm">Sales Aging List</div>
            <Table>
              <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-muted [&_th]:shadow-[0_1px_0_0] [&_th]:shadow-border">
                <TableRow>
                  <TableHead>Broker</TableHead>
                  <TableHead>Due Date</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Invoice No</TableHead>
                  <TableHead>Bill Date</TableHead>
                  <TableHead className="text-right">Bill Amount</TableHead>
                  <TableHead className="text-right">Net Amount Due</TableHead>
                  <TableHead className="text-center">Status</TableHead>
                  <TableHead className="text-center">Due Days</TableHead>
                  <TableHead className="text-center">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dueInvoices.length === 0 ? (
                  <TableRow><TableCell colSpan={10} className="text-center text-muted-foreground py-8">No sales dues found.</TableCell></TableRow>
                ) : (
                  (pageRows ?? []).map((inv) => (
                    <Fragment key={inv.id}>
                      <TableRow className="cursor-pointer hover:bg-muted/50" onClick={() => setExpandedId(expandedId === inv.id ? null : inv.id)}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {expandedId === inv.id ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                            {inv.brokerName ?? '-'}
                          </div>
                        </TableCell>
                        <TableCell className="font-medium">{shortDate(inv.dueDate.toISOString())}</TableCell>
                        <TableCell>{inv.partyName}</TableCell>
                        <TableCell className="font-mono text-xs">{inv.invoiceNumber ?? '-'}</TableCell>
                        <TableCell>{shortDate(inv.billDate.toISOString())}</TableCell>
                        <TableCell className="text-right">{rupees(inv.billAmount)}</TableCell>
                        <TableCell className="text-right font-bold text-emerald-600 dark:text-emerald-400">
                          {rupees(inv.netAmount)}
                        </TableCell>
                        <TableCell className="text-center">
                          <span className={`font-semibold ${inv.status === 'Paid' ? 'text-emerald-600 dark:text-emerald-400' : inv.status === 'Unpaid' ? 'text-rose-600 dark:text-rose-400' : 'text-amber-600 dark:text-amber-400'}`}>
                            {inv.status}
                          </span>
                        </TableCell>
                        <TableCell className="text-center">
                          {inv.status !== 'Paid' ? (
                            inv.dueDaysAfter > 0 ? (
                              <span className="text-rose-600 dark:text-rose-400 font-bold">{inv.dueDaysAfter} days</span>
                            ) : (
                              <span className="text-muted-foreground">Not due</span>
                            )
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </TableCell>
                        <TableCell className="text-center">
                          <div className="flex items-center justify-center gap-2">
                            {inv.status !== 'Paid' && (
                              <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); openReceiveDialog(inv); }}>
                                Received
                              </Button>
                            )}
                            {inv.deletableReceiptIds.length > 0 && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-rose-600 hover:text-rose-700 dark:text-rose-400"
                                disabled={undoMutation.isPending}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (window.confirm(`Undo receipt for ${inv.partyName}${inv.invoiceNumber ? ` (${inv.invoiceNumber})` : ''}? This deletes the receipt and its ledger entry.`)) {
                                    undoMutation.mutate(inv.deletableReceiptIds);
                                  }
                                }}
                              >
                                <Undo2 className="h-3.5 w-3.5 mr-1" /> Undo
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                      {expandedId === inv.id && (
                        <TableRow className="bg-muted/20">
                          <TableCell colSpan={10} className="p-0 border-b-0">
                            <div className="px-10 py-4">
                              <h4 className="font-semibold text-sm mb-3">Allocated Receipts</h4>
                              {inv.appliedReceipts.length > 0 ? (
                                <Table className="bg-background border rounded-md shadow-sm w-full max-w-lg">
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead className="w-[150px]">Date</TableHead>
                                      <TableHead>Amount Paid</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {inv.appliedReceipts.map((ar, idx) => (
                                      <TableRow key={idx}>
                                        <TableCell>{shortDate(new Date(ar.date).toISOString())}</TableCell>
                                        <TableCell className="font-medium text-emerald-600">
                                          {rupees(ar.amount)}
                                          {ar.isTdsOrShortage && <span className="text-xs text-muted-foreground ml-2">(TDS/Shortage)</span>}
                                        </TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              ) : (
                                <p className="text-sm text-muted-foreground">No receipts have been allocated to this invoice yet.</p>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          <PaginationBar page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalPages={totalPages} total={total} />
        </>
      )}

      {/* Receive dialog */}
      <Dialog open={!!receiveDialog} onOpenChange={(open) => { if (!open) setReceiveDialog(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Record Receipt</DialogTitle>
          </DialogHeader>
          {receiveDialog && (
            <div className="space-y-4 py-2">
              <p className="text-sm text-muted-foreground">
                {receiveDialog.inv.partyName} · {receiveDialog.inv.invoiceNumber ?? 'No invoice'}
              </p>
              <p className="text-sm font-medium">
                Outstanding: <span className="text-emerald-600">{rupees(receiveDialog.inv.netAmount)}</span>
              </p>

              <div className="space-y-1">
                <Label htmlFor="recv-date">Date Received</Label>
                <Input
                  id="recv-date"
                  type="date"
                  value={receiveDialog.date}
                  onChange={(e) => setReceiveDialog((d) => d && ({ ...d, date: e.target.value }))}
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor="recv-amount">Amount Received (₹)</Label>
                <Input
                  id="recv-amount"
                  type="number"
                  step="0.01"
                  value={receiveDialog.amountReceived}
                  onChange={(e) => setReceiveDialog((d) => d && ({ ...d, amountReceived: e.target.value }))}
                />
              </div>

              <div className="flex items-center space-x-2 pt-2">
                <input
                  type="checkbox"
                  id="enable-tds"
                  checked={enableTds}
                  onChange={(e) => setEnableTds(e.target.checked)}
                  className="w-4 h-4 rounded border-gray-300 text-primary focus:ring-primary"
                />
                <Label htmlFor="enable-tds" className="cursor-pointer">Deduct TDS (0.1%)</Label>
              </div>

              {enableTds && (
                <div className="space-y-1">
                  <Label htmlFor="recv-tds">
                    TDS (₹)
                    <span className="ml-2 text-xs text-muted-foreground font-normal">
                      0.1% of bill = {rupees(receiveDialog.inv.billAmount * TDS_RATE)}
                    </span>
                  </Label>
                  <Input
                    id="recv-tds"
                    type="number"
                    step="0.01"
                    value={receiveDialog.tdsAmount}
                    onChange={(e) => setReceiveDialog((d) => d && ({ ...d, tdsAmount: e.target.value }))}
                  />
                </div>
              )}

              <div className="space-y-1">
                <Label htmlFor="recv-shortage">
                  Shortage / Kata (₹)
                  {autoShortage > 0 && (
                    <span className="ml-2 text-xs text-amber-600 font-normal">
                      auto: {rupees(autoShortage)}
                    </span>
                  )}
                </Label>
                <Input
                  id="recv-shortage"
                  type="number"
                  step="0.01"
                  value={receiveDialog.shortageAmount}
                  onChange={(e) => setReceiveDialog((d) => d && ({ ...d, shortageAmount: e.target.value }))}
                />
                <p className="text-xs text-muted-foreground">
                  Enter the shortage/weight deduction from party kata. Leave 0 if full amount received.
                </p>
              </div>

              {/* Settlement summary */}
              {(() => {
                const received = parseFloat(receiveDialog.amountReceived) || 0;
                const tds = enableTds ? (parseFloat(receiveDialog.tdsAmount) || 0) : 0;
                const shortage = parseFloat(receiveDialog.shortageAmount) || 0;
                const total = received + tds + shortage;
                return (
                  <div className="rounded-md bg-muted/50 px-3 py-2 text-xs space-y-0.5">
                    <div className="flex justify-between"><span>Cash received</span><span>{rupees(received)}</span></div>
                    {enableTds && <div className="flex justify-between"><span>TDS</span><span>{rupees(tds)}</span></div>}
                    <div className="flex justify-between"><span>Shortage</span><span>{rupees(shortage)}</span></div>
                    <div className="flex justify-between font-semibold border-t pt-1 mt-1">
                      <span>Total settled</span>
                      <span className={total > receiveDialog.inv.netAmount + 0.01 ? 'text-amber-600' : 'text-emerald-600'}>
                        {rupees(total)}
                      </span>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReceiveDialog(null)}>Cancel</Button>
            <Button onClick={submitReceive} disabled={receiveMutation.isPending}>
              {receiveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirm Receipt'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
