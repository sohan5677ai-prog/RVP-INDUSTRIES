import { useState, useMemo, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, apiBlob } from '@/lib/api';
import type { Party, SaleOrder, Receipt, SaleProduct } from '@/lib/types';
import { rupees, shortDate } from '@/lib/format';
import { settledByDispatch, isDispatchPaid, dispatchTotal } from '@/lib/saleStatus';
import { shortageGst, shortageWithGst, saleTds, round2, SALE_GST_RATE } from '@/lib/receiptCalc';
import { productDescription } from '@/lib/productNames';
import { invalidateReceiptQueries } from '@/lib/receiptCache';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TrendingUp, Loader2, ChevronRight, Undo2, IndianRupee, AlertTriangle, ArrowLeftRight, FileDown } from 'lucide-react';
import { Fragment } from 'react';
import { Segmented } from '@/components/ui/segmented';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PaginationBar } from '@/components/ui/pagination-bar';
import { SearchInput } from '@/components/ui/search-input';
import { usePagedRows } from '@/lib/usePagedRows';
import { ExportButtons } from '@/components/ExportButtons';
import { PageHeader } from '@/components/PageHeader';
import { SetOffDialog } from '@/components/SetOffDialog';
import { ExpandPanel, PanelLabel, PanelStack, PanelCard, PanelTitle, Figure, PanelEmpty } from '@/components/ExpandPanel';
import { cn } from '@/lib/utils';
import type { ExportColumn, ExportTone } from '@/lib/export';

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
// - fully-unpaid, partially-paid, and in-transit shipments alike (all three are
// money owed; only the collections clock differs).
type PayFilter = 'ALL' | 'PAID' | 'UNPAID';

const PAY_FILTERS: { value: PayFilter; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'PAID', label: 'Paid' },
  { value: 'UNPAID', label: 'Unpaid' },
];

// Due-month dropdown. Invoices are bucketed by the month their payment falls
// due (dispatch/delivery date + the order's credit days), NOT by bill date -
// "show me what's due in August" is a collections question, not a billing one.
const ALL_MONTHS = 'ALL';

/** Local-time YYYY-MM key for a date (never UTC - a 1st-of-month due date in IST
 *  would otherwise slide into the previous month). */
function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' });
}

/** What an in-transit shipment's due date will be measured FROM once it lands.
 *  Shown in place of a date, because until the lorry is marked delivered there
 *  is no day to count from - only the credit term. */
function creditTermLabel(dueDays: number): string {
  if (dueDays <= 0) return 'On delivery';
  return `Delivery + ${dueDays} ${dueDays === 1 ? 'day' : 'days'}`;
}

/** A receipt stores the shortage GST-inclusive (that is how it clears the bill).
 *  Split it back into goods value + GST so the expanded row can show both. */
function splitShortage(total: number, gstExempt: boolean): { base: number; gst: number } {
  if (!(total > 0)) return { base: 0, gst: 0 };
  const base = gstExempt ? total : round2(total / (1 + SALE_GST_RATE));
  return { base, gst: round2(total - base) };
}

const TILE_TONES = {
  neutral: 'text-foreground',
  emerald: 'text-emerald-600 dark:text-emerald-400',
  amber: 'text-amber-600 dark:text-amber-500',
  rose: 'text-rose-600 dark:text-rose-400',
} as const;

/** One number in the expanded row's settlement strip.
 *  `whitespace-normal` is load-bearing: TableCell sets whitespace-nowrap and the
 *  panel inherits it, so a hint longer than the tile could not wrap and spilled
 *  out past the tile's right edge. `min-w-0` lets the tile shrink to its column
 *  instead of being sized by that text. */
function SettleTile({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: keyof typeof TILE_TONES;
}) {
  return (
    <div className="glass min-w-0 rounded-xl px-3.5 py-3">
      <div className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn('mt-1 truncate font-mono text-base font-semibold tabular-nums', TILE_TONES[tone])}>{value}</div>
      {hint && (
        <div className="mt-0.5 whitespace-normal break-words text-[10px] leading-tight text-muted-foreground">
          {hint}
        </div>
      )}
    </div>
  );
}

interface OutstandingInvoice {
  id: string;
  partyId: string;
  product: SaleProduct;
  brokerName: string | null;
  dueDate: Date;
  partyName: string;
  invoiceNumber: string | null;
  vehicleNumber: string | null; // the lorry this invoice shipped on

  billDate: Date;
  billAmount: number;   // billed total (base + GST), whole rupees
  saleBase: number;     // sale value EXCLUDING GST - the TDS calc base
  shortageBase: number; // buyer-kata shortage goods value (GST-excluded) recorded at delivery
  gstExempt: boolean;   // whether 5% GST applies to the shortage deduction
  discount: number;
  netAmount: number;    // remaining due after FIFO allocation
  totalAmount: number;
  cashReceived: number; // actual cash (excludes TDS/shortage) applied to this invoice
  // The two non-cash ways a bill gets cleared, kept apart from the cash so the
  // expanded row can show WHY the invoice closed on less money than it billed.
  tdsDeducted: number;      // TDS withheld by the buyer against this invoice
  shortageDeducted: number; // shortage/kata claim allowed, GST-inclusive
  dueDaysAfter: number;
  status: string;
  // Dispatched but not yet marked delivered. The receivable is real (the ledger
  // debits the buyer at dispatch, so this page has to agree with it), but the
  // credit clock hasn't started, so dueDate above is a placeholder that must
  // never be shown as a date - the UI prints the credit TERM instead.
  inTransit: boolean;
  dueDays: number; // the order's credit days, for that term label
  appliedReceipts: {
    date: string;
    cash: number;      // money that actually landed in the bank
    tds: number;
    shortage: number;  // GST-inclusive, as booked
    amount: number;    // cash + tds + shortage = what this receipt cleared
    isTdsOrShortage?: boolean;
  }[];
  deletableReceiptIds: string[];
}

interface ReceiveDialogState {
  inv: OutstandingInvoice;
  date: string;
  amountReceived: string;
  tdsAmount: string;
  shortageAmount: string;
}

/** A lorry number reduced to its letters and digits, so a search for "AP39T1234"
 *  still finds a plate recorded as "AP 39 T 1234". */
function plate(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Status colour, shared by the PDF, the Excel sheet and the print view. */
function statusTone(i: OutstandingInvoice): ExportTone {
  if (i.status === 'Paid') return 'success';
  if (i.inTransit) return 'muted';
  return i.dueDaysAfter > 0 ? 'danger' : 'warning';
}

const SALE_DUES_COLUMNS: ExportColumn<OutstandingInvoice>[] = [
  { header: 'Broker', value: (i) => i.brokerName ?? '' },
  // An undelivered shipment has no due date yet - credit days run from delivery.
  // Export the credit TERM instead, so nobody chases a date we invented.
  { header: 'Due Date', value: (i) => (i.inTransit ? creditTermLabel(i.dueDays) : shortDate(i.dueDate.toISOString())) },
  { header: 'Customer', value: (i) => i.partyName },
  { header: 'Product', value: (i) => i.product },
  { header: 'Invoice No', value: (i) => i.invoiceNumber ?? '' },
  // The lorry number is how the buyer's office finds the bill on their side, so
  // it travels with every exported line.
  { header: 'Vehicle No', value: (i) => i.vehicleNumber ?? '' },
  { header: 'Bill Date', value: (i) => shortDate(i.billDate.toISOString()) },
  { header: 'Bill Amount', value: (i) => rupees(i.billAmount), excel: (i) => i.billAmount, numFmt: '#,##0.00', align: 'right', total: true },
  { header: 'Shortage Deducted', value: (i) => rupees(i.shortageDeducted), excel: (i) => i.shortageDeducted, numFmt: '#,##0.00', align: 'right', total: true },
  { header: 'TDS Withheld', value: (i) => rupees(i.tdsDeducted), excel: (i) => i.tdsDeducted, numFmt: '#,##0.00', align: 'right', total: true },
  { header: 'Cash Received', value: (i) => rupees(i.cashReceived), excel: (i) => i.cashReceived, numFmt: '#,##0.00', align: 'right', total: true },
  {
    header: 'Net Amount Due', value: (i) => rupees(i.netAmount), excel: (i) => i.netAmount,
    numFmt: '#,##0.00', align: 'right', total: true,
    tone: (i) => (i.netAmount > 0.01 ? (i.dueDaysAfter > 0 ? 'danger' : 'default') : 'muted'),
  },
  { header: 'Status', value: (i) => i.status, align: 'center', tone: statusTone },
  { header: 'Due Days', value: (i) => (i.status === 'Paid' ? '' : i.inTransit ? 'Awaiting delivery' : i.dueDaysAfter), align: 'center', tone: (i) => (i.status !== 'Paid' && !i.inTransit && i.dueDaysAfter > 0 ? 'danger' : 'default') },
];

export default function SaleDuesPage() {
  const qc = useQueryClient();
  const [receiveDialog, setReceiveDialog] = useState<ReceiveDialogState | null>(null);
  const [enableTds, setEnableTds] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [productFilter, setProductFilter] = useState<ProductFilter>('ALL');
  const [payFilter, setPayFilter] = useState<PayFilter>('ALL');
  const [monthFilter, setMonthFilter] = useState<string>(ALL_MONTHS);
  const [search, setSearch] = useState('');
  // Bill-date window. Kept separate from the Due Month picker above, which asks a
  // different question: "what falls due in August" vs "what did we bill in August".
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  // Knock a buyer's open invoices off against what we owe them as a supplier.
  const [setOffOpen, setSetOffOpen] = useState(false);
  const [downloadingPdf, setDownloadingPdf] = useState(false);

  const { data: parties, isLoading: loadingParties } = useQuery({
    queryKey: ['parties'],
    queryFn: () => api<Party[]>('/parties'),
  });

  const { data: saleOrders, isLoading: loadingSales } = useQuery({
    queryKey: ['sale-orders', { all: true }],
    queryFn: () => api<SaleOrder[]>('/sale-orders?all=true'),
  });

  const { data: receipts, isLoading: loadingReceipts } = useQuery({
    // Full history - dues are matched against every receipt, not just latest 100.
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
      invalidateReceiptQueries(qc);
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
      invalidateReceiptQueries(qc);
    },
    onError: () => toast.error('Failed to remove receipt'),
  });

  const isLoading = loadingParties || loadingSales || loadingReceipts;

  // Settlement is invoice-based ONLY - no FIFO, no on-account spillover. Each
  // shipment is cleared solely by the buyer receipts stamped with its own
  // saleDispatchId, and the Paid decision runs through the SAME shared helpers
  // (settledByDispatch / isDispatchPaid) the Pappu/Husk sales pages use, so the
  // "Mark Paid" button and this page can never disagree. A general receipt with
  // no saleDispatchId clears nothing here. Keyed strictly on the source data so
  // it recomputes only when data changes (not on every keystroke in the dialog).
  const outstandingInvoices = useMemo<OutstandingInvoice[]>(() => {
  // BOTH counts as a buyer - byproduct customers (Nalla Chintapandu / Pokkulu /
  // Waste / Pre Cleaner Dust) are usually seed suppliers too, so filtering on
  // 'BUYER' alone silently dropped every one of their invoices from this list.
  const buyers = parties?.filter((p) => p.type === 'BUYER' || p.type === 'BOTH') ?? [];
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
      let tdsDeducted = 0;
      let shortageDeducted = 0;
      const appliedReceipts: OutstandingInvoice['appliedReceipts'] = [];
      const deletableReceiptIds: string[] = [];
      linked.forEach((r) => {
        const cash = Number(r.amount);
        const tds = Number(r.tdsAmount ?? 0);
        const shortage = Number(r.shortageAmount ?? 0);
        const clearing = cash + tds + shortage;
        cashReceived += cash;
        tdsDeducted += tds;
        shortageDeducted += shortage;
        deletableReceiptIds.push(r.id);
        appliedReceipts.push({ date: r.date, cash, tds, shortage, amount: clearing, isTdsOrShortage: cash === 0 });
      });

      const paid = isDispatchPaid(d, rate, settled);
      const remaining = paid ? 0 : Math.max(0, total - cleared);

      // A shipment still on the road is a receivable (the ledger debits the buyer
      // at dispatch - see the SALE- lines in ledger.controller), so it belongs on
      // this list. But it is not yet COLLECTABLE: credit days run from delivery.
      // Calling it "Unpaid" and ticking overdue days against it would invent an
      // arrears that nobody can chase, so it reads "In Transit" and the clock
      // stays at zero until Mark-as-Delivered stamps deliveredDate.
      const inTransit = d.status !== 'DELIVERED';
      const status = paid
        ? 'Paid'
        : cleared > 0.01 ? 'Partially Paid'
        : inTransit ? 'In Transit'
        : 'Unpaid';

      // For an in-transit row this is a PLACEHOLDER, not a forecast: dispatch
      // date + credit days would say a lorry that left on the 8th is due on the
      // 9th, which assumes it arrives the day it leaves. It exists only to give
      // the row a sort key and a month bucket - the UI prints the credit term
      // ("Delivery + 1 day") in its place until deliveredDate is stamped.
      const start = d.deliveredDate || d.dispatchDate;
      const dueDate = new Date(start);
      dueDate.setDate(dueDate.getDate() + (o.dueDays || 0));
      const dueDaysAfter = inTransit
        ? 0
        : Math.max(0, Math.ceil((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24)));

      rows.push({
        id: d.id,
        partyId: b.id,
        product: o.product,
        brokerName: o.broker?.name ?? null,
        dueDate,
        partyName: b.name,
        invoiceNumber: d.invoiceNumber,
        vehicleNumber: d.vehicleNumber ?? null,
        billDate: new Date(d.dispatchDate),
        billAmount: total,
        saleBase: d.weightKg * rate,
        shortageBase: (Number(d.shortageKg) || 0) * rate,
        gstExempt: o.gstExempt,
        discount: 0,
        netAmount: remaining,
        totalAmount: total,
        cashReceived,
        tdsDeducted: round2(tdsDeducted),
        shortageDeducted: round2(shortageDeducted),
        dueDaysAfter,
        status,
        inTransit,
        dueDays: o.dueDays || 0,
        appliedReceipts,
        deletableReceiptIds,
      });
    });
  });

  rows.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
  return rows;
  }, [parties, saleOrders, receipts]);

  // Deep link from the overdue-dues login reminder:
  //   /reports/sale-dues?collect=<saleDispatchId>
  // opens Record Receipt on that exact invoice instead of dropping the user on
  // the list to hunt for it. Fires once and then strips the param, so a refresh
  // (or Back) doesn't pop the dialog again.
  const [searchParams, setSearchParams] = useSearchParams();
  const collectId = searchParams.get('collect');
  const collectHandled = useRef(false);
  const duesLoaded = !loadingParties && !loadingSales && !loadingReceipts;

  useEffect(() => {
    if (!collectId || collectHandled.current || !duesLoaded) return;
    collectHandled.current = true;

    const clearParam = () => {
      const next = new URLSearchParams(searchParams);
      next.delete('collect');
      setSearchParams(next, { replace: true });
    };

    const inv = outstandingInvoices.find((i) => i.id === collectId);
    if (!inv || inv.netAmount <= 0.01) {
      toast.info('That invoice is already settled.');
      clearParam();
      return;
    }

    // Clear the filters so the row is actually on screen behind the dialog.
    setProductFilter('ALL');
    setPayFilter('ALL');
    setMonthFilter(ALL_MONTHS);
    setSearch('');
    setFromDate('');
    setToDate('');
    setExpandedId(inv.id);
    openReceiveDialog(inv);
    clearParam();
  }, [collectId, duesLoaded, outstandingInvoices]);

  // Buyer money that credited the party ledger but was never stamped with an
  // invoice. Settlement here is invoice-based only, so these rupees clear
  // nothing - every bill they were meant to pay still reads Unpaid below. They
  // used to be invisible on this page, which is exactly how a paid invoice ends
  // up looking outstanding; surfaced as a banner so the gap is obvious.
  const onAccountReceipts = useMemo(() => {
    const rows = (receipts ?? []).filter((r) => r.type === 'BUYER' && !r.saleDispatchId);
    const byParty = new Map<string, { name: string; amount: number; count: number }>();
    for (const r of rows) {
      const key = r.partyId ?? 'unknown';
      const cur = byParty.get(key) ?? { name: r.party?.name ?? 'Unknown buyer', amount: 0, count: 0 };
      cur.amount += Number(r.amount) + Number(r.tdsAmount ?? 0) + Number(r.shortageAmount ?? 0);
      cur.count += 1;
      byParty.set(key, cur);
    }
    const parties = [...byParty.values()].sort((a, b) => b.amount - a.amount);
    return { total: parties.reduce((s, p) => s + p.amount, 0), parties };
  }, [receipts]);

  // Month options come from the FULL invoice set (not the product-filtered one)
  // so switching product tabs never yanks the selected month out of the list.
  // Newest month first - collections work is almost always on the recent end.
  // In-transit shipments are left out: their dueDate is a placeholder, so
  // counting them into "August 2026" would answer a collections question with a
  // guess. They stay visible under All months.
  const monthOptions = useMemo(() => {
    const counts = new Map<string, number>();
    outstandingInvoices.forEach((inv) => {
      if (inv.inTransit) return;
      const k = monthKey(inv.dueDate);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    });
    return [...counts.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([key, count]) => ({ key, label: monthLabel(key), count }));
  }, [outstandingInvoices]);

  // Both date bounds are parsed as LOCAL midnight, never `new Date('2026-08-01')`
  // - that is UTC midnight, which in IST lands at 05:30 and would drop an invoice
  // billed early on the boundary day.
  const query = search.trim().toLowerCase();
  const plateQuery = plate(query);
  const fromTime = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : null;
  const toTime = toDate ? new Date(`${toDate}T23:59:59.999`).getTime() : null;
  const filtersActive = !!query || !!fromDate || !!toDate;

  const visibleInvoices = outstandingInvoices.filter((inv) => {
    if (!matchesProductFilter(inv.product, productFilter)) return false;
    if (monthFilter !== ALL_MONTHS && (inv.inTransit || monthKey(inv.dueDate) !== monthFilter)) return false;
    if (query && !(
      inv.partyName.toLowerCase().includes(query) ||
      (inv.invoiceNumber ?? '').toLowerCase().includes(query) ||
      // Lorry numbers get written every which way ("AP39T1234", "AP 39 T 1234"),
      // so match on the letters and digits alone rather than the spacing.
      (!!plateQuery && plate(inv.vehicleNumber).includes(plateQuery))
    )) return false;
    const billTime = inv.billDate.getTime();
    if (fromTime !== null && billTime < fromTime) return false;
    if (toTime !== null && billTime > toTime) return false;
    return true;
  });

  const totalBillingAll = visibleInvoices.reduce((sum, item) => sum + item.totalAmount, 0);
  const totalReceiptsAll = visibleInvoices.reduce((sum, item) => sum + item.cashReceived, 0);
  const totalOutstanding = visibleInvoices.reduce((sum, item) => sum + item.netAmount, 0);
  // Split out the part of the receivable that is still on the road - it is money
  // owed, but not money you can chase yet.
  const inTransitOutstanding = visibleInvoices.reduce((sum, item) => sum + (item.inTransit ? item.netAmount : 0), 0);

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

  /** Cash still expected = outstanding − shortage(base + 5% GST) − TDS. Both
   *  deductions come OFF the amount received (same as "Mark as Paid"). */
  function expectedCash(inv: OutstandingInvoice, shortageStr: string, tdsStr: string, tdsOn: boolean) {
    const shortageTotal = shortageWithGst(parseFloat(shortageStr) || 0, inv.gstExempt);
    const tds = tdsOn ? (parseFloat(tdsStr) || 0) : 0;
    return String(round2(Math.max(0, inv.netAmount - shortageTotal - tds)));
  }

  function openReceiveDialog(inv: OutstandingInvoice) {
    const today = new Date().toISOString().slice(0, 10);
    // TDS (0.1%) is on the sale value EXCLUDING GST - not the GST-inclusive bill.
    const tds = String(saleTds(inv.saleBase));
    // Auto-deduct the buyer-kata shortage (goods value) recorded at delivery, and
    // net it - plus its 5% GST - off the cash we expect to receive.
    const shortage = inv.shortageBase > 0 ? String(round2(inv.shortageBase)) : '0';
    setEnableTds(false);
    setReceiveDialog({
      inv,
      date: today,
      amountReceived: expectedCash(inv, shortage, tds, false),
      tdsAmount: tds,
      shortageAmount: shortage,
    });
  }

  function submitReceive() {
    if (!receiveDialog) return;
    const received = parseFloat(receiveDialog.amountReceived);
    const tds = enableTds ? (parseFloat(receiveDialog.tdsAmount) || 0) : 0;
    const shortageBase = parseFloat(receiveDialog.shortageAmount) || 0;
    // Shortage clears the GST-inclusive invoice, so book base + 5% GST on it.
    const shortage = shortageWithGst(shortageBase, receiveDialog.inv.gstExempt);
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

  // Buyer-grouped Outstanding Sales Dues PDF - same renderer as the WhatsApp
  // owner digest, scoped server-side to whatever's currently on screen (Due
  // Month, product tab, search, bill-date window). Deliberately ignores the
  // Paid/Unpaid tab: the report is inherently about what's still outstanding,
  // and a paid invoice has nothing left to show in it either way.
  async function downloadDuesPdf() {
    setDownloadingPdf(true);
    try {
      const params = new URLSearchParams();
      if (productFilter !== 'ALL') params.set('product', productFilter);
      if (monthFilter !== ALL_MONTHS) params.set('month', monthFilter);
      if (search.trim()) params.set('search', search.trim());
      if (fromDate) params.set('from', fromDate);
      if (toDate) params.set('to', toDate);
      const qs = params.toString();
      const blob = await apiBlob(`/sale-dues/report.pdf${qs ? `?${qs}` : ''}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Outstanding-Sales-Dues-${new Date().toISOString().slice(0, 10)}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Failed to generate the dues PDF');
    } finally {
      setDownloadingPdf(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sale Dues"
        description="Aging list of outstanding buyer sales invoices. Each one is cleared only by the receipts recorded against it."
        icon={TrendingUp}
        actions={
          <div className="flex items-center gap-2">
            {/* Buyers we also purchase from: square the invoice off against what
                we owe them, instead of two payments crossing. */}
            <Button variant="outline" onClick={() => setSetOffOpen(true)}>
              <ArrowLeftRight className="h-4 w-4" /> Set off vs Purchases
            </Button>
            {/* Same buyer-grouped PDF as the WhatsApp owner digest, scoped to
                whatever's currently filtered (product tab, due month, search,
                bill-date window) - not the Paid/Unpaid tab, since the report is
                inherently about what's still outstanding. */}
            <Button variant="outline" onClick={downloadDuesPdf} disabled={downloadingPdf}>
              {downloadingPdf ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
              Download Dues PDF
            </Button>
            <ExportButtons
            filename="Sale_Dues"
            title="Sale Dues (Aging)"
            subtitle={[
              PRODUCT_FILTERS.find((f) => f.value === productFilter)?.label,
              PAY_FILTERS.find((f) => f.value === payFilter)?.label,
              monthFilter === ALL_MONTHS ? 'All months' : `Due ${monthLabel(monthFilter)}`,
              // Spell out any search/date narrowing on the sheet itself, so nobody
              // reads a filtered export as the full ledger.
              ...(fromDate || toDate ? [`Billed ${fromDate || 'start'} to ${toDate || 'today'}`] : []),
              ...(query ? [`Search "${search.trim()}"`] : []),
              `${dueInvoices.length} invoice(s)`,
            ].join(' · ')}
            columns={SALE_DUES_COLUMNS}
            rows={dueInvoices}
            />
          </div>
        }
      />

      <SetOffDialog open={setOffOpen} onOpenChange={setSetOffOpen} parties={parties} />

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

        {/* Due-month picker: pick "August 2026" to see only invoices falling due that month. */}
        <div className="flex items-center gap-2 ml-auto">
          <Label htmlFor="due-month" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">
            Due Month
          </Label>
          <Select value={monthFilter} onValueChange={setMonthFilter}>
            <SelectTrigger id="due-month" className="h-9 w-[200px]">
              <SelectValue placeholder="All months" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_MONTHS}>All months</SelectItem>
              {monthOptions.map((m) => (
                <SelectItem key={m.key} value={m.key}>
                  {m.label} ({m.count})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {monthFilter !== ALL_MONTHS && (
            <Button variant="ghost" size="sm" className="h-9 px-2 text-xs" onClick={() => setMonthFilter(ALL_MONTHS)}>
              Clear
            </Button>
          )}
        </div>
      </div>

      {/* Find one bill: by buyer or invoice number, and/or within a billing window. */}
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          value={search}
          onValueChange={setSearch}
          placeholder="Search buyer, invoice or lorry no…"
          containerClassName="w-full sm:w-80"
          className="h-9"
        />
        <div className="flex items-center gap-2">
          <Label htmlFor="bill-from" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">
            Bill Date
          </Label>
          <Input
            id="bill-from"
            type="date"
            value={fromDate}
            max={toDate || undefined}
            onChange={(e) => setFromDate(e.target.value)}
            className="h-9 w-[150px]"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <Input
            id="bill-to"
            type="date"
            value={toDate}
            min={fromDate || undefined}
            onChange={(e) => setToDate(e.target.value)}
            className="h-9 w-[150px]"
          />
        </div>
        {filtersActive && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9 px-2 text-xs"
            onClick={() => { setSearch(''); setFromDate(''); setToDate(''); }}
          >
            Clear
          </Button>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          Showing {visibleInvoices.length} of {outstandingInvoices.length} invoices
        </span>
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
                {inTransitOutstanding > 0 && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    incl. <span className="font-semibold text-sky-600 dark:text-sky-400">{rupees(inTransitOutstanding)}</span> in transit (not yet due)
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {onAccountReceipts.parties.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-5 py-4 dark:border-amber-900 dark:bg-amber-950/30">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                    {rupees(onAccountReceipts.total)} received but not applied to any invoice
                  </p>
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    These collections credited the buyer's ledger without settling a bill, so the invoices they
                    paid still show as unpaid below. Reverse each one on the Receipts page and record it again,
                    ticking the invoices it covers.
                  </p>
                  <ul className="pt-1 text-xs text-amber-800 dark:text-amber-300">
                    {onAccountReceipts.parties.map((p) => (
                      <li key={p.name}>
                        <span className="font-medium">{p.name}</span> · {rupees(p.amount)}
                        {p.count > 1 ? ` (${p.count} receipts)` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}

          <div className="rounded-lg border bg-card overflow-auto max-h-[70vh]">
            <div className="px-5 py-4 border-b font-semibold text-sm flex items-center gap-2">
              Sales Aging List
              {monthFilter !== ALL_MONTHS && (
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                  Due in {monthLabel(monthFilter)}
                </span>
              )}
            </div>
            <Table>
              <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-muted [&_th]:shadow-[0_1px_0_0] [&_th]:shadow-border">
                <TableRow>
                  <TableHead>Broker</TableHead>
                  <TableHead>Due Date</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Product</TableHead>
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
                  <TableRow>
                    <TableCell colSpan={11} className="text-center text-muted-foreground py-8">
                      {filtersActive
                        ? 'No invoices match this search or date range.'
                        : monthFilter === ALL_MONTHS
                          ? 'No sales dues found.'
                          : `No invoices falling due in ${monthLabel(monthFilter)}.`}
                    </TableCell>
                  </TableRow>
                ) : (
                  (pageRows ?? []).map((inv) => (
                    <Fragment key={inv.id}>
                      <TableRow
                        className={cn('cursor-pointer transition-colors', expandedId === inv.id ? 'bg-accent/40' : 'hover:bg-accent/30')}
                        onClick={() => setExpandedId(expandedId === inv.id ? null : inv.id)}
                      >
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <ChevronRight className={cn('h-4 w-4 text-muted-foreground transition-transform duration-200', expandedId === inv.id && 'rotate-90 text-primary')} />
                            {inv.brokerName ?? '-'}
                          </div>
                        </TableCell>
                        <TableCell
                          className={cn('font-medium', inv.inTransit && 'text-muted-foreground')}
                          title={inv.inTransit ? 'Not delivered yet - the due date is set once delivery is recorded' : undefined}
                        >
                          {inv.inTransit ? (
                            <span className="text-xs">{creditTermLabel(inv.dueDays)}</span>
                          ) : (
                            shortDate(inv.dueDate.toISOString())
                          )}
                        </TableCell>
                        <TableCell>{inv.partyName}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{productDescription(inv.product)}</TableCell>
                        <TableCell className="font-sans text-xs font-medium text-foreground/80">{inv.invoiceNumber ?? '-'}</TableCell>
                        <TableCell>{shortDate(inv.billDate.toISOString())}</TableCell>
                        <TableCell className="text-right">{rupees(inv.billAmount)}</TableCell>
                        <TableCell className="text-right font-bold text-emerald-600 dark:text-emerald-400">
                          {rupees(inv.netAmount)}
                        </TableCell>
                        <TableCell className="text-center">
                          <span
                            className={cn(
                              'font-semibold',
                              inv.status === 'Paid' ? 'text-emerald-600 dark:text-emerald-400'
                                : inv.status === 'Unpaid' ? 'text-rose-600 dark:text-rose-400'
                                : inv.status === 'In Transit' ? 'text-sky-600 dark:text-sky-400'
                                : 'text-amber-600 dark:text-amber-400',
                            )}
                            title={inv.inTransit ? 'Dispatched but not marked delivered - billed, not yet collectable' : undefined}
                          >
                            {inv.status}
                          </span>
                        </TableCell>
                        <TableCell className="text-center">
                          {inv.status !== 'Paid' ? (
                            inv.inTransit ? (
                              <span className="text-xs text-muted-foreground">Awaiting delivery</span>
                            ) : inv.dueDaysAfter > 0 ? (
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
                        <ExpandPanel colSpan={11}>
                          {/* How the bill was settled, broken into its parts: a buyer who
                              deducts shortage and TDS clears the full invoice while paying
                              less cash, so the lump "amount" alone hid both deductions. */}
                          {(() => {
                            const sh = splitShortage(inv.shortageDeducted, inv.gstExempt);
                            const settled = round2(inv.cashReceived + inv.tdsDeducted + inv.shortageDeducted);
                            const balance = round2(inv.billAmount - settled);
                            return (
                              <>
                                <PanelLabel>Settlement Breakdown</PanelLabel>
                                <div className="mb-5 grid max-w-4xl grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
                                  <SettleTile label="Bill Amount" value={rupees(inv.billAmount)} />
                                  <SettleTile
                                    label="Shortage / Kata"
                                    value={inv.shortageDeducted > 0 ? `-${rupees(inv.shortageDeducted)}` : rupees(0)}
                                    tone={inv.shortageDeducted > 0 ? 'amber' : 'neutral'}
                                    hint={
                                      inv.shortageDeducted > 0
                                        ? sh.gst > 0
                                          ? `${rupees(sh.base)} goods + ${rupees(sh.gst)} GST`
                                          : 'GST-exempt sale'
                                        : 'No shortage claimed'
                                    }
                                  />
                                  <SettleTile
                                    label="TDS Withheld"
                                    value={inv.tdsDeducted > 0 ? `-${rupees(inv.tdsDeducted)}` : rupees(0)}
                                    tone={inv.tdsDeducted > 0 ? 'amber' : 'neutral'}
                                    hint={inv.tdsDeducted > 0 ? '0.1% on sale value (excl. GST)' : 'Not deducted'}
                                  />
                                  <SettleTile
                                    label="Amount Received"
                                    value={rupees(inv.cashReceived)}
                                    tone="emerald"
                                    hint="Cash actually collected"
                                  />
                                  <SettleTile
                                    label={balance > 0.01 ? 'Still Outstanding' : balance < -0.01 ? 'Excess Received' : 'Fully Settled'}
                                    value={rupees(Math.abs(balance))}
                                    tone={balance > 0.01 ? 'rose' : 'emerald'}
                                    hint={
                                      balance > 0.01
                                        ? `${rupees(settled)} cleared`
                                        : balance < -0.01
                                          ? 'More received than billed'
                                          : 'Bill cleared in full'
                                    }
                                  />
                                </div>
                              </>
                            );
                          })()}

                          <PanelLabel>Allocated Receipts · {inv.appliedReceipts.length}</PanelLabel>
                          {inv.appliedReceipts.length > 0 ? (
                            <PanelStack>
                              {inv.appliedReceipts.map((ar, idx) => (
                                <PanelCard
                                  key={idx}
                                  icon={IndianRupee}
                                  className="max-w-4xl"
                                  identity={
                                    <>
                                      <PanelTitle>
                                        <span className="font-mono text-sm font-semibold">{shortDate(new Date(ar.date).toISOString())}</span>
                                        {ar.isTdsOrShortage && <span className="text-xs text-muted-foreground">Deduction only - no cash</span>}
                                      </PanelTitle>
                                    </>
                                  }
                                  figures={
                                    <>
                                      <Figure label="Received" value={rupees(ar.cash)} valueClass="text-emerald-600 dark:text-emerald-400" />
                                      {ar.shortage > 0 && (
                                        <Figure label="Shortage" value={`-${rupees(ar.shortage)}`} valueClass="text-amber-600 dark:text-amber-500" />
                                      )}
                                      {ar.tds > 0 && (
                                        <Figure label="TDS" value={`-${rupees(ar.tds)}`} valueClass="text-amber-600 dark:text-amber-500" />
                                      )}
                                      <Figure label="Bill Cleared" value={rupees(ar.amount)} />
                                    </>
                                  }
                                />
                              ))}
                            </PanelStack>
                          ) : (
                            <PanelEmpty>No receipts have been allocated to this invoice yet.</PanelEmpty>
                          )}
                        </ExpandPanel>
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
                  onChange={(e) => {
                    const on = e.target.checked;
                    setEnableTds(on);
                    setReceiveDialog((d) => d && ({
                      ...d,
                      amountReceived: expectedCash(d.inv, d.shortageAmount, d.tdsAmount, on),
                    }));
                  }}
                  className="w-4 h-4 rounded border-gray-300 text-primary focus:ring-primary"
                />
                <Label htmlFor="enable-tds" className="cursor-pointer">Deduct TDS (0.1%)</Label>
              </div>

              {enableTds && (
                <div className="space-y-1">
                  <Label htmlFor="recv-tds">
                    TDS (₹)
                    <span className="ml-2 text-xs text-muted-foreground font-normal">
                      0.1% of sale value (excl. GST) = {rupees(saleTds(receiveDialog.inv.saleBase))}
                    </span>
                  </Label>
                  <Input
                    id="recv-tds"
                    type="number"
                    step="0.01"
                    value={receiveDialog.tdsAmount}
                    onChange={(e) => setReceiveDialog((d) => d && ({
                      ...d,
                      tdsAmount: e.target.value,
                      amountReceived: expectedCash(d.inv, d.shortageAmount, e.target.value, true),
                    }))}
                  />
                </div>
              )}

              <div className="space-y-1">
                <Label htmlFor="recv-shortage">Shortage / Kata (₹)</Label>
                <Input
                  id="recv-shortage"
                  type="number"
                  step="0.01"
                  value={receiveDialog.shortageAmount}
                  onChange={(e) => setReceiveDialog((d) => d && ({
                    ...d,
                    shortageAmount: e.target.value,
                    amountReceived: expectedCash(d.inv, e.target.value, d.tdsAmount, enableTds),
                  }))}
                />
                <p className="text-xs text-muted-foreground">
                  Goods value of the party-kata shortage (auto-filled from delivery). 5% GST is added on top. Leave 0 if full amount received.
                </p>
              </div>

              {/* Settlement summary - mirrors the "Mark as Paid" breakdown so both agree */}
              {(() => {
                const received = parseFloat(receiveDialog.amountReceived) || 0;
                const tds = enableTds ? (parseFloat(receiveDialog.tdsAmount) || 0) : 0;
                const shortageBase = parseFloat(receiveDialog.shortageAmount) || 0;
                const shortageGstAmt = shortageGst(shortageBase, receiveDialog.inv.gstExempt);
                const netDue = round2(receiveDialog.inv.netAmount - shortageBase - shortageGstAmt - tds);
                const balance = round2(netDue - received);
                return (
                  <div className="rounded-md bg-muted/50 px-3 py-2 text-xs space-y-0.5">
                    <div className="flex justify-between"><span>Outstanding</span><span>{rupees(receiveDialog.inv.netAmount)}</span></div>
                    {shortageBase > 0 && (
                      <div className="flex justify-between text-amber-600 dark:text-amber-500">
                        <span>Shortage</span><span>-{rupees(shortageBase)}</span>
                      </div>
                    )}
                    {shortageGstAmt > 0 && (
                      <div className="flex justify-between text-amber-600 dark:text-amber-500">
                        <span>GST on shortage (5%)</span><span>-{rupees(shortageGstAmt)}</span>
                      </div>
                    )}
                    {tds > 0 && (
                      <div className="flex justify-between text-amber-600 dark:text-amber-500">
                        <span>TDS (0.1%)</span><span>-{rupees(tds)}</span>
                      </div>
                    )}
                    <div className="flex justify-between font-semibold border-t pt-1 mt-1">
                      <span>Net due</span><span>{rupees(netDue)}</span>
                    </div>
                    <div className="flex justify-between"><span>Cash received</span><span>{rupees(received)}</span></div>
                    {Math.abs(balance) > 0.01 && (
                      <div className="flex justify-between font-medium">
                        <span>{balance > 0 ? 'Still outstanding' : 'Excess received'}</span>
                        <span className="text-amber-600 dark:text-amber-500">{rupees(Math.abs(balance))}</span>
                      </div>
                    )}
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
