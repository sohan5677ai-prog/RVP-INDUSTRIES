import { Fragment, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Truck, PackageCheck, Upload, Loader2, FileText, Printer, ChevronRight, ShoppingCart, CalendarClock, IndianRupee, Undo2, TrendingUp, TrendingDown } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { SaleOrder, SaleStatus, SaleProduct, SaleDispatch, Party, Broker } from '@/lib/types';
import { rupees, shortDate, toTonnes } from '@/lib/format';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/PageHeader';
import { Segmented } from '@/components/ui/segmented';
import { Combobox } from '@/components/ui/combobox';
import { cn } from '@/lib/utils';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const GST_RATE = 0.05;

/** Per-order pappu profit/loss, from the date-aware seed allocation (server). */
interface PappuMargin {
  orderId: string;
  ratePerKg: number;
  revenue: number;
  freight: number;
  freightPerKg: number;
  brokerage: number;
  seedKg: number;
  seedCost: number;
  seedWacPerKg: number;
  seedCostPerPappuKg: number;
  prodCostPerKg: number;
  prodCost: number;
  netRealization: number;
  margin: number;
  marginPerKg: number;
  marginPct: number;
  seedBands: { price: number; seedKg: number; cost: number }[];
}

const PRODUCT_META: Record<SaleProduct, { title: string; noun: string }> = {
  PAPPU: { title: 'Pappu Sales', noun: 'Pappu' },
  HUSK: { title: 'Husk Sales', noun: 'Husk' },
  WASTE: { title: 'Tamarind Waste Sales', noun: 'Tamarind Waste' },
  TPS: { title: 'TPS (Brokens) Sales', noun: 'TPS (Brokens)' },
  SHELL: { title: 'Tamarind Shell Sales', noun: 'Tamarind Shell' },
  PRECLEANER_DUST: { title: 'Pre Cleaner Dust Sales', noun: 'Pre Cleaner Dust' },
  NALLA_POKKULU: { title: 'Nalla Pokkulu Sales', noun: 'Nalla Pokkulu' },
  NALLA_CHINTAPANDU: { title: 'Nalla Chintapandu Sales', noun: 'Nalla Chintapandu' },
};

const statusVariant: Record<SaleStatus, 'soft' | 'warning' | 'success' | 'outline'> = {
  PENDING: 'warning',
  PARTIAL: 'outline',
  DISPATCHED: 'soft',
  DELIVERED: 'success',
};

const STATUS_FILTERS: ('ALL' | SaleStatus)[] = ['ALL', 'PENDING', 'PARTIAL', 'DISPATCHED'];
const NO_BROKER = '__none__';

const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

/** Due date = deliveredDate + dueDays. Null until both are known. */
function dueDateIso(deliveredDate: string | null | undefined, dueDays: number | null | undefined): string | null {
  if (!deliveredDate || dueDays == null) return null;
  const d = new Date(deliveredDate);
  d.setDate(d.getDate() + dueDays);
  return d.toISOString();
}

function isDueSoon(iso: string | null): boolean {
  if (!iso) return false;
  const diff = (new Date(iso).getTime() - Date.now()) / 86400000;
  return diff >= 0 && diff <= 7;
}

function isOverdue(iso: string | null): boolean {
  if (!iso) return false;
  return new Date(iso).getTime() < Date.now();
}

/** Dispatched (sum of shipments) - falls back to summing if the server field is absent. */
function dispatchedKgOf(o: SaleOrder): number {
  if (o.dispatchedKg != null) return o.dispatchedKg;
  return (o.dispatches ?? []).reduce((s, d) => s + d.weightKg, 0);
}
function remainingKgOf(o: SaleOrder): number {
  if (o.remainingKg != null) return o.remainingKg;
  return Math.max(0, o.tonnageKg - dispatchedKgOf(o));
}

export default function SalesProduct({ product, hideHeader }: { product: SaleProduct; hideHeader?: boolean }) {
  const meta = PRODUCT_META[product];
  const navigate = useNavigate();
  const qc = useQueryClient();

  const hasBroker = !['WASTE', 'TPS', 'SHELL', 'PRECLEANER_DUST', 'NALLA_POKKULU', 'NALLA_CHINTAPANDU'].includes(product);
  const isPappu = product === 'PAPPU';
  // Order row: ⌄ Date · Shipments · Party · [Broker] · Destination · Ordered ·
  // Dispatched · Remaining · Price · Status · Actions. Per-shipment detail lives
  // in the expandable panel.
  const colCount = 10 + (hasBroker ? 1 : 0);

  const [statusFilter, setStatusFilter] = useState<'ALL' | SaleStatus>('ALL');
  const [brokerFilter, setBrokerFilter] = useState<string>('ALL');
  const [partyFilter, setPartyFilter] = useState<string>('ALL');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleRow = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const { data: orders, isLoading: loadingOrders } = useQuery({
    queryKey: ['sale-orders', product],
    queryFn: () => api<SaleOrder[]>(`/sale-orders?product=${product}`),
  });
  const { data: parties, isLoading: loadingParties } = useQuery({ queryKey: ['parties'], queryFn: () => api<Party[]>('/parties') });
  const { data: brokers, isLoading: loadingBrokers } = useQuery({ queryKey: ['brokers'], queryFn: () => api<Broker[]>('/brokers') });

  // Per-order profit/loss margin (Pappu only), keyed by order id.
  const { data: margins } = useQuery({
    queryKey: ['pappu-margins'],
    queryFn: () => api<PappuMargin[]>('/inventory/pappu-margins'),
    enabled: isPappu,
  });
  const marginById = useMemo(() => new Map((margins ?? []).map((m) => [m.orderId, m])), [margins]);

  const visible = (orders ?? []).filter((o) => {
    if (statusFilter !== 'ALL' && o.status !== statusFilter) return false;
    if (brokerFilter !== 'ALL') {
      if (brokerFilter === NO_BROKER && o.brokerId) return false;
      if (brokerFilter !== NO_BROKER && o.brokerId !== brokerFilter) return false;
    }
    if (partyFilter !== 'ALL' && o.buyerId !== partyFilter) return false;
    const d = o.saleDate.slice(0, 10);
    if (fromDate && d < fromDate) return false;
    if (toDate && d > toDate) return false;
    return true;
  });

  const isLoading = loadingOrders || loadingParties || loadingBrokers;

  // ── Dispatch dialog ────────────────────────────────────────────────────────
  const [dispatchOrder, setDispatchOrder] = useState<SaleOrder | null>(null);
  const [kataFile, setKataFile] = useState<File | null>(null);
  const [vehicleNumber, setVehicleNumber] = useState('');
  const [dispatchTonnes, setDispatchTonnes] = useState('');
  const [extractingKata, setExtractingKata] = useState(false);

  const dispatchRemaining = dispatchOrder ? remainingKgOf(dispatchOrder) : 0;
  const dispatchTonnesNum = Number(dispatchTonnes) || 0;
  const dispatchOverflow = dispatchOrder ? Math.round(dispatchTonnesNum * 1000) > dispatchRemaining : false;

  function openDispatch(o: SaleOrder) {
    setDispatchOrder(o);
    setKataFile(null);
    setVehicleNumber('');
    setDispatchTonnes(String(remainingKgOf(o) / 1000));
  }

  async function extractKata(file: File) {
    setExtractingKata(true);
    try {
      const fd = new FormData();
      fd.append('document', file);
      fd.append('kind', 'kata');
      const data = await api<{ invoiceNumber: string | null; vehicleNumber: string | null; tonnageKg: number | null }>(
        '/sale-orders/extract', { method: 'POST', body: fd, multipart: true }
      );
      if (data.vehicleNumber) setVehicleNumber(data.vehicleNumber);
      if (data.tonnageKg) setDispatchTonnes(String(data.tonnageKg / 1000));
      toast.success('Read kata slip - fields pre-filled');
    } catch (e) {
      toast.error(getErrorMessage(e));
    } finally {
      setExtractingKata(false);
    }
  }

  const dispatchMutation = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      if (kataFile) fd.append('kata', kataFile);
      fd.append('vehicleNumber', vehicleNumber);
      fd.append('tonnageKg', String(Math.round((Number(dispatchTonnes) || 0) * 1000)));
      return api(`/sale-orders/${dispatchOrder!.id}/dispatch`, { method: 'POST', body: fd, multipart: true });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sale-orders'] });
      qc.invalidateQueries({ queryKey: ['black-seed-stock'] });
      qc.invalidateQueries({ queryKey: ['pappu-margins'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success('Dispatched - raise the invoice when ready');
      setDispatchOrder(null);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  // ── Undo dispatch (mistaken dispatch) ───────────────────────────────────────
  const [undoTarget, setUndoTarget] = useState<{ dispatch: SaleDispatch; order: SaleOrder } | null>(null);

  /** A shipment can be undone only while it's still a plain DISPATCHED record. */
  function canUndo(d: SaleDispatch): boolean {
    return d.status === 'DISPATCHED'
      && !d.invoiceNumber
      && (!d.irn || d.irnStatus === 'CANCELLED')
      && (!d.ewbNumber || d.ewbStatus === 'CANCELLED');
  }

  const undoMutation = useMutation({
    mutationFn: () => api(`/sale-dispatches/${undoTarget!.dispatch.id}/undo`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sale-orders'] });
      qc.invalidateQueries({ queryKey: ['black-seed-stock'] });
      qc.invalidateQueries({ queryKey: ['pappu-margins'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success('Dispatch undone - stock and ledger reversed');
      setUndoTarget(null);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  // ── Raise Invoice (per dispatch) ────────────────────────────────────────────
  const [invoiceDispatch, setInvoiceDispatch] = useState<{ dispatch: SaleDispatch; order: SaleOrder } | null>(null);

  const raiseInvoiceMutation = useMutation({
    mutationFn: () => api<SaleDispatch>(`/sale-dispatches/${invoiceDispatch!.dispatch.id}/invoice`, { method: 'POST' }),
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ['sale-orders'] });
      toast.success(`Invoice ${saved.invoiceNumber} generated`);
      setInvoiceDispatch(null);
      navigate(`/sale-dispatches/${saved.id}/invoice`);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const invoiceBase = invoiceDispatch ? invoiceDispatch.dispatch.weightKg * Number(invoiceDispatch.order.ratePerKg) : 0;
  const invoiceGst = Math.round(invoiceBase * GST_RATE * 100) / 100;

  // ── Mark Delivered dialog (captures buyer kata + shortage) ───────────────────
  const [deliverDispatch, setDeliverDispatch] = useState<{ dispatch: SaleDispatch; order: SaleOrder } | null>(null);
  const [deliverKataFile, setDeliverKataFile] = useState<File | null>(null);
  const [buyerKataTonnes, setBuyerKataTonnes] = useState('');

  function openDeliver(dispatch: SaleDispatch, order: SaleOrder) {
    setDeliverDispatch({ dispatch, order });
    setDeliverKataFile(null);
    setBuyerKataTonnes(String(dispatch.weightKg / 1000));
  }

  const buyerKataKg = Math.round((Number(buyerKataTonnes) || 0) * 1000);
  const deliverShortageKg = deliverDispatch ? Math.max(0, deliverDispatch.dispatch.weightKg - buyerKataKg) : 0;
  const deliverOverweight = deliverDispatch ? buyerKataKg > deliverDispatch.dispatch.weightKg : false;

  const deliverMutation = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      if (deliverKataFile) fd.append('kata', deliverKataFile);
      if (buyerKataKg > 0) fd.append('buyerKataKg', String(buyerKataKg));
      return api(`/sale-dispatches/${deliverDispatch!.dispatch.id}/deliver`, { method: 'POST', body: fd, multipart: true });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sale-orders'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success('Shipment marked as Delivered');
      setDeliverDispatch(null);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  // ── Mark Paid dialog (captures TDS + receipt amount) ───────────────────
  const [payDispatch, setPayDispatch] = useState<{ dispatch: SaleDispatch; order: SaleOrder } | null>(null);
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));
  const [payAmount, setPayAmount] = useState('');
  const [payTds, setPayTds] = useState('');
  const [payShortage, setPayShortage] = useState('');

  function openPaymentDialog(dispatch: SaleDispatch, order: SaleOrder) {
    setPayDispatch({ dispatch, order });
    setPayDate(new Date().toISOString().slice(0, 10));
    
    // Auto calculate defaults
    const invoiceBase = dispatch.weightKg * Number(order.ratePerKg);
    const invoiceGst = Math.round(invoiceBase * GST_RATE * 100) / 100;
    const invoiceTotal = invoiceBase + invoiceGst;
    const shortageDeduction = Number(dispatch.creditNoteAmount) || 0;
    const expectedNet = invoiceTotal - shortageDeduction - Number(dispatch.tdsAmount || 0);
    
    setPayAmount(String(expectedNet));
    setPayTds(dispatch.tdsAmount ? String(dispatch.tdsAmount) : '');
    setPayShortage(shortageDeduction > 0 ? String(shortageDeduction) : '');
  }

  function handlePayAmountChange(v: string) {
    setPayAmount(v);
    if (!payDispatch) return;
    const amount = Number(v);
    const order = payDispatch.order;
    const dispatch = payDispatch.dispatch;
    
    const invoiceBase = dispatch.weightKg * Number(order.ratePerKg);
    const invoiceGst = Math.round(invoiceBase * GST_RATE * 100) / 100;
    const invoiceTotal = invoiceBase + invoiceGst;
    const shortageDeduction = Number(payShortage) || 0;
    const expectedNet = invoiceTotal - shortageDeduction;
    
    // If amount is less than expected net, auto-calc TDS as 0.1% of base
    if (amount < expectedNet) {
      const autoTds = Math.round(invoiceBase * 0.001);
      setPayTds(String(autoTds));
    } else if (amount >= expectedNet) {
      setPayTds('');
    }
  }

  // Recalculate if user changes shortage manually
  function handlePayShortageChange(v: string) {
    setPayShortage(v);
    if (!payDispatch) return;
    const order = payDispatch.order;
    const dispatch = payDispatch.dispatch;
    
    const invoiceBase = dispatch.weightKg * Number(order.ratePerKg);
    const invoiceGst = Math.round(invoiceBase * GST_RATE * 100) / 100;
    const invoiceTotal = invoiceBase + invoiceGst;
    const shortageDeduction = Number(v) || 0;
    const expectedNet = invoiceTotal - shortageDeduction - Number(payTds || 0);
    
    setPayAmount(String(expectedNet));
  }

  const payMutation = useMutation({
    mutationFn: () => api(`/sale-dispatches/${payDispatch!.dispatch.id}/mark-paid`, {
      method: 'POST',
      body: JSON.stringify({
        date: new Date(payDate).toISOString(),
        amount: Number(payAmount),
        tdsAmount: Number(payTds) || 0,
        shortageAmount: Number(payShortage) || 0,
      }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sale-orders'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success('Payment recorded successfully');
      setPayDispatch(null);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  // ── E-Invoice / E-Way Bill (TaxPro GSP) actions ───────────────────────────
  const [ewbDispatch, setEwbDispatch] = useState<{ dispatch: SaleDispatch; order: SaleOrder } | null>(null);
  const [transporterId, setTransporterId] = useState('');
  const [transporterName, setTransporterName] = useState('');
  const [transDistance, setTransDistance] = useState('0');
  const [transMode, setTransMode] = useState('1');
  const [ewbVehicleNo, setEwbVehicleNo] = useState('');
  const [vehicleType, setVehicleType] = useState('R');
  const [transDocNo, setTransDocNo] = useState('');
  const [transDocDt, setTransDocDt] = useState('');

  const [cancelTarget, setCancelTarget] = useState<{ id: string; type: 'einvoice' | 'ewaybill' } | null>(null);
  const [cancelReason, setCancelReason] = useState('2'); // default "2" - Data Entry Mistake
  const [cancelRemarks, setCancelRemarks] = useState('Cancelled from ERP');

  const generateIrnMutation = useMutation({
    mutationFn: (id: string) => api<{ updated: SaleDispatch; message: string }>(`/sale-dispatches/${id}/einvoice`, { method: 'POST' }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['sale-orders'] });
      toast.success(res.message);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const cancelIrnMutation = useMutation({
    mutationFn: () => api<{ updated: SaleDispatch; message: string }>(`/sale-dispatches/${cancelTarget!.id}/einvoice/cancel`, {
      method: 'POST',
      body: { cancelReason, cancelRemarks },
    }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['sale-orders'] });
      toast.success(res.message);
      setCancelTarget(null);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const generateEwbMutation = useMutation({
    mutationFn: () => api<{ updated: SaleDispatch; message: string }>(`/sale-dispatches/${ewbDispatch!.dispatch.id}/ewaybill`, {
      method: 'POST',
      body: {
        transporterId,
        transporterName,
        transDistance,
        transMode,
        vehicleNumber: ewbVehicleNo,
        vehicleType,
        transDocNo,
        transDocDt,
      },
    }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['sale-orders'] });
      toast.success(res.message);
      setEwbDispatch(null);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const cancelEwbMutation = useMutation({
    mutationFn: () => api<{ updated: SaleDispatch; message: string }>(`/sale-dispatches/${cancelTarget!.id}/ewaybill/cancel`, {
      method: 'POST',
      body: { cancelReason, cancelRemarks },
    }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['sale-orders'] });
      toast.success(res.message);
      setCancelTarget(null);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  function openEwb(dispatch: SaleDispatch, order: SaleOrder) {
    setEwbDispatch({ dispatch, order });
    setTransporterId('');
    setTransporterName('');
    setTransDistance('0');
    setTransMode('1');
    setEwbVehicleNo(dispatch.vehicleNumber || '');
    setVehicleType('R');
    setTransDocNo('');
    setTransDocDt('');
  }

  // Transporter GSTIN is optional, but if entered it must be a valid 15-char GSTIN
  // (NIC rejects the whole request otherwise, error 5002 "Transin").
  const transporterIdNorm = transporterId.trim().toUpperCase();
  const transporterIdInvalid = transporterIdNorm.length > 0 && !/^[0-9]{2}[A-Z0-9]{13}$/.test(transporterIdNorm);

  function openCancel(id: string, type: 'einvoice' | 'ewaybill') {
    setCancelTarget({ id, type });
    setCancelReason(type === 'einvoice' ? '2' : '3');
    setCancelRemarks('Cancelled from ERP');
  }

  // ── Full workflow view ────────────────────────────────────────────────
  const filtersActive = statusFilter !== 'ALL' || partyFilter !== 'ALL' || brokerFilter !== 'ALL' || !!fromDate || !!toDate;

  // ── Metrics (for Husk) ──────────────────────────────────────────────────
  const totalSoldKg = visible.reduce((sum, o) => sum + o.tonnageKg, 0);
  const totalRevenue = visible.reduce((sum, o) => sum + (o.tonnageKg * Number(o.ratePerKg)), 0);
  const wacPrice = totalSoldKg > 0 ? totalRevenue / totalSoldKg : 0;
  const dispatchedRevenue = visible.reduce((sum, o) => sum + (dispatchedKgOf(o) * Number(o.ratePerKg)), 0);
  const pendingRevenue = totalRevenue - dispatchedRevenue;
  const realizationPct = totalRevenue > 0 ? (dispatchedRevenue / totalRevenue) * 100 : 0;

  return (
    <div className="space-y-6">
      {!hideHeader && (
        <PageHeader
          icon={ShoppingCart}
          title={meta.title}
          description={`Manage the full ${meta.noun.toLowerCase()} lifecycle - dispatch lorries against each order, invoice every shipment, and mark delivered.`}
        />
      )}

      {/* Metrics Dashboard */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total {meta.noun} Sold</CardTitle>
            <PackageCheck className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-emerald-600">{toTonnes(totalSoldKg).toFixed(2)} MT</div>
            <p className="text-[10px] text-muted-foreground mt-1">Total ordered tonnage</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Wt Avg Price</CardTitle>
            <IndianRupee className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{rupees(wacPrice)}/kg</div>
            <p className="text-[10px] text-muted-foreground mt-1">Weighted average rate</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Revenue Pipeline</CardTitle>
            <IndianRupee className="h-4 w-4 text-sky-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-sky-600">{rupees(totalRevenue)}</div>
            <p className="text-[10px] text-muted-foreground mt-1">Total gross revenue</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Pending Value</CardTitle>
            <Truck className="h-4 w-4 text-rose-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-rose-600">{rupees(pendingRevenue)}</div>
            <p className="text-[10px] text-muted-foreground mt-1">{realizationPct.toFixed(0)}% revenue realized</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="glass rounded-2xl p-3 flex flex-wrap items-center gap-2.5">
        <Segmented
          options={STATUS_FILTERS.map((s) => ({ label: s === 'ALL' ? 'All' : titleCase(s), value: s }))}
          value={statusFilter}
          onValueChange={setStatusFilter}
          size="sm"
        />
        <Combobox
          options={[{ value: 'ALL', label: 'All parties' }, ...(parties ?? []).filter((p) => p.type !== 'SUPPLIER').map((p) => ({ value: p.id, label: p.name }))]}
          value={partyFilter}
          onChange={setPartyFilter}
          placeholder="All parties"
          searchPlaceholder="Search party…"
          ariaLabel="Filter by party"
          className="w-52"
        />
        {hasBroker && (
          <Combobox
            options={[{ value: 'ALL', label: 'All brokers' }, { value: NO_BROKER, label: 'No broker' }, ...(brokers ?? []).map((b) => ({ value: b.id, label: b.name }))]}
            value={brokerFilter}
            onChange={setBrokerFilter}
            placeholder="All brokers"
            searchPlaceholder="Search broker…"
            ariaLabel="Filter by broker"
            className="w-44"
          />
        )}
        <div className="flex items-center gap-1.5">
          <Input aria-label="From date" type="date" value={fromDate} max={toDate || undefined} onChange={(e) => setFromDate(e.target.value)} className="w-40" />
          <span className="text-muted-foreground text-xs">→</span>
          <Input aria-label="To date" type="date" value={toDate} min={fromDate || undefined} onChange={(e) => setToDate(e.target.value)} className="w-40" />
        </div>
        {filtersActive && (
          <button type="button" onClick={() => { setStatusFilter('ALL'); setPartyFilter('ALL'); setBrokerFilter('ALL'); setFromDate(''); setToDate(''); }}
            className="ml-auto text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">Clear filters</button>
        )}
      </div>

      {/* Table */}
      <div className="glass rounded-2xl overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Shipments</TableHead>
              <TableHead>Party</TableHead>
              {hasBroker && <TableHead>Broker</TableHead>}
              <TableHead>Destination</TableHead>
              <TableHead className="text-right">Ordered</TableHead>
              <TableHead className="text-right">Dispatched</TableHead>
              <TableHead className="text-right">Remaining</TableHead>
              <TableHead className="text-right">Price/kg</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-32 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && <TableRow><TableCell colSpan={colCount} className="h-24 text-center text-muted-foreground">Loading…</TableCell></TableRow>}
            {!isLoading && visible.length === 0 && (
              <TableRow><TableCell colSpan={colCount} className="h-28 text-center text-muted-foreground">No {meta.noun.toLowerCase()} sales matching filters.</TableCell></TableRow>
            )}
            {visible.map((o) => {
              const dispatchedKg = dispatchedKgOf(o);
              const remainingKg = remainingKgOf(o);
              const dispatches = o.dispatches ?? [];
              const isOpen = expanded.has(o.id);
              const margin = isPappu ? marginById.get(o.id) : undefined;
              return (
                <Fragment key={o.id}>
                  {/* Order row - click to expand its shipments */}
                  <TableRow
                    className={cn('cursor-pointer transition-colors', isOpen ? 'bg-accent/40' : 'hover:bg-accent/30')}
                    onClick={() => toggleRow(o.id)}
                  >
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <ChevronRight className={cn('h-4 w-4 text-muted-foreground transition-transform duration-200', isOpen && 'rotate-90 text-primary')} />
                        <span className="text-muted-foreground">{shortDate(o.saleDate)}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      {dispatches.length > 0
                        ? <Badge variant="soft">{dispatches.length} shipment{dispatches.length > 1 ? 's' : ''}</Badge>
                        : <span className="text-xs text-muted-foreground">none yet</span>}
                    </TableCell>
                    <TableCell className="font-medium text-foreground">{o.buyer?.name ?? '-'}</TableCell>
                    {hasBroker && <TableCell className="text-muted-foreground">{o.broker?.name ?? '-'}</TableCell>}
                    <TableCell className="text-muted-foreground">{o.destination ?? '-'}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums font-medium">{toTonnes(o.tonnageKg).toFixed(2)} t</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{toTonnes(dispatchedKg).toFixed(2)} t</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {remainingKg > 0
                        ? <span className="text-amber-600 dark:text-amber-400">{toTonnes(remainingKg).toFixed(2)} t</span>
                        : <span className="text-emerald-600 dark:text-emerald-400">0.00 t</span>}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {rupees(o.ratePerKg)}
                      {margin && (
                        <span className={cn('block text-[10px] font-medium', margin.margin >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>
                          {margin.margin >= 0 ? '▲' : '▼'} {rupees(Math.abs(margin.marginPerKg))}/kg
                        </span>
                      )}
                    </TableCell>
                    <TableCell><Badge variant={statusVariant[o.status]}>{titleCase(o.status)}</Badge></TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
                        {remainingKg > 0
                          ? <Button size="sm" variant="outline" onClick={() => openDispatch(o)}><Truck className="h-3.5 w-3.5" /> Dispatch</Button>
                          : dispatches.length > 0 ? <Badge variant="success">Fully dispatched</Badge> : null}
                      </div>
                    </TableCell>
                  </TableRow>

                  {/* Expanded shipments panel */}
                  {isOpen && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={colCount} className="p-0">
                        <div className="border-t border-border/60 bg-muted/25 px-5 py-4">
                          {isPappu && margin && <PappuMarginPanel margin={margin} />}
                          <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                            Shipments · {dispatches.length}
                          </div>
                          {dispatches.length === 0 ? (
                            <div className="rounded-xl border border-dashed border-border py-6 text-center text-sm text-muted-foreground">
                              No shipments yet. Use <span className="font-medium text-foreground">Dispatch</span> to ship a lorry against this order.
                            </div>
                          ) : (
                            <div className="space-y-2.5">
                              {dispatches.map((d) => {
                                const netDue = (d.weightKg * Number(o.ratePerKg) * (1 + GST_RATE));
                                const dueIso = dueDateIso(d.deliveredDate, o.dueDays);
                                const overdue = isOverdue(dueIso);
                                const soon = isDueSoon(dueIso);
                                return (
                                  <div key={d.id} className="glass rounded-xl p-3.5">
                                    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
                                      {/* identity */}
                                      <div className="flex min-w-0 items-center gap-3">
                                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                                          <Truck className="h-5 w-5" />
                                        </div>
                                        <div className="min-w-0">
                                          <div className="flex flex-wrap items-center gap-2">
                                            <span className="font-mono text-sm font-semibold">
                                              {d.invoiceNumber ?? <span className="font-sans text-xs font-medium text-amber-600 dark:text-amber-400">Invoice not raised</span>}
                                            </span>
                                            <Badge variant={statusVariant[d.status]}>{titleCase(d.status)}</Badge>
                                          </div>
                                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                                            <span>{shortDate(d.dispatchDate)}</span><span className="opacity-40">·</span>
                                            <span>{d.vehicleNumber ?? 'no vehicle'}</span><span className="opacity-40">·</span>
                                            <span className="font-mono">{toTonnes(d.weightKg).toFixed(2)} t</span>
                                            {d.kataFileUrl && <a onClick={(e) => e.stopPropagation()} href={d.kataFileUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">Dispatch kata</a>}
                                            {d.buyerKataFileUrl && <a onClick={(e) => e.stopPropagation()} href={d.buyerKataFileUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">Buyer kata</a>}
                                          </div>
                                          {/* E-Invoice and E-Way Bill Status Info */}
                                          {d.invoiceNumber && (
                                            <div className="mt-2 flex flex-wrap gap-2 text-xs">
                                              {d.irn ? (
                                                <div className={cn(
                                                  "px-2 py-0.5 rounded flex items-center gap-1.5 border font-mono text-[10px]",
                                                  d.irnStatus === 'CANCELLED' 
                                                    ? "bg-rose-50 border-rose-200 text-rose-700 dark:bg-rose-950/20 dark:border-rose-900" 
                                                    : "bg-indigo-50 border-indigo-200 text-indigo-700 dark:bg-indigo-950/20 dark:border-indigo-900"
                                                )}>
                                                  <span className="font-semibold font-sans">E-Invoice:</span>
                                                  <span>{d.irn.slice(0, 8)}...{d.irn.slice(-6)}</span>
                                                  <Badge variant="outline" className={cn("text-[9px] px-1 py-0 h-4", d.irnStatus === 'CANCELLED' ? "text-rose-600 border-rose-200" : "text-indigo-600 border-indigo-200")}>
                                                    {d.irnStatus}
                                                  </Badge>
                                                </div>
                                              ) : (
                                                <span className="text-muted-foreground text-[10px] italic">E-Invoice not generated</span>
                                              )}
                                              {d.ewbNumber && (
                                                <div className={cn(
                                                  "px-2 py-0.5 rounded flex items-center gap-1.5 border font-mono text-[10px]",
                                                  d.ewbStatus === 'CANCELLED' 
                                                    ? "bg-rose-50 border-rose-200 text-rose-700 dark:bg-rose-950/20 dark:border-rose-900" 
                                                    : "bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-950/20 dark:border-emerald-900"
                                                )}>
                                                  <span className="font-semibold font-sans">E-Way Bill:</span>
                                                  <span>{d.ewbNumber}</span>
                                                  <Badge variant="outline" className={cn("text-[9px] px-1 py-0 h-4", d.ewbStatus === 'CANCELLED' ? "text-rose-600 border-rose-200" : "text-emerald-600 border-emerald-200")}>
                                                    {d.ewbStatus}
                                                  </Badge>
                                                </div>
                                              )}
                                            </div>
                                          )}
                                        </div>
                                      </div>
                                      {/* figures */}
                                      <div className="flex items-center gap-5">
                                        <Figure label="Net due" value={rupees(netDue)} valueClass="text-forest" />
                                        <div className="text-right">
                                          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Due</div>
                                          <div className="mt-0.5 flex items-center justify-end gap-1 text-sm font-medium">
                                            {dueIso ? (
                                              <span className={overdue ? 'text-destructive' : soon ? 'text-amber-600 dark:text-amber-400' : ''}>
                                                {overdue && <CalendarClock className="mr-0.5 inline h-3.5 w-3.5" />}
                                                {shortDate(dueIso)}{o.dueDays != null ? ` · ${o.dueDays}d` : ''}
                                              </span>
                                            ) : <span className="text-muted-foreground">-</span>}
                                          </div>
                                        </div>
                                      </div>
                                      {/* actions */}
                                      <div className="flex items-center gap-1.5 flex-wrap justify-end max-w-sm">
                                        {d.invoiceNumber ? (
                                          <>
                                            <Button size="sm" variant="outline" onClick={() => navigate(`/sale-dispatches/${d.id}/invoice`)}>
                                              <Printer className="h-3.5 w-3.5" /> Invoice
                                            </Button>
                                            
                                            {/* E-Invoice Action Buttons */}
                                            {!d.irn && (
                                              <Button size="sm" variant="outline" className="border-indigo-200 text-indigo-700 hover:bg-indigo-50" onClick={() => generateIrnMutation.mutate(d.id)} disabled={generateIrnMutation.isPending}>
                                                {generateIrnMutation.isPending ? 'IRN...' : 'Gen IRN'}
                                              </Button>
                                            )}
                                            {d.irn && d.irnStatus !== 'CANCELLED' && (
                                              <Button size="sm" variant="outline" className="border-rose-200 text-rose-700 hover:bg-rose-50" onClick={() => openCancel(d.id, 'einvoice')}>
                                                Cancel IRN
                                              </Button>
                                            )}

                                            {/* E-Way Bill Action Buttons */}
                                            {d.irn && d.irnStatus !== 'CANCELLED' && !d.ewbNumber && (
                                              <Button size="sm" variant="outline" className="border-emerald-200 text-emerald-700 hover:bg-emerald-50" onClick={() => openEwb(d, o)}>
                                                Gen EWB
                                              </Button>
                                            )}
                                            {d.ewbNumber && d.ewbStatus !== 'CANCELLED' && (
                                              <>
                                                <Button size="sm" variant="outline" className="border-emerald-200 text-emerald-700 hover:bg-emerald-50" onClick={() => navigate(`/sale-dispatches/${d.id}/ewaybill`)}>
                                                  <Printer className="h-3.5 w-3.5 mr-1" /> EWB
                                                </Button>
                                                <Button size="sm" variant="outline" className="border-rose-200 text-rose-700 hover:bg-rose-50" onClick={() => openCancel(d.id, 'ewaybill')}>
                                                  Cancel EWB
                                                </Button>
                                              </>
                                            )}
                                          </>
                                        ) : (
                                          <Button size="sm" variant="outline" onClick={() => setInvoiceDispatch({ dispatch: d, order: o })}>
                                            <FileText className="h-3.5 w-3.5" /> Raise invoice
                                          </Button>
                                        )}
                                        {d.status === 'DISPATCHED' && (
                                          <Button size="sm" variant="forest" onClick={() => openDeliver(d, o)}>
                                            <PackageCheck className="h-3.5 w-3.5" /> Mark delivered
                                          </Button>
                                        )}
                                        {d.status === 'DELIVERED' && (
                                          <Button size="sm" variant="outline" className="border-emerald-200 text-emerald-700 hover:bg-emerald-50" onClick={() => openPaymentDialog(d, o)}>
                                            <IndianRupee className="h-3.5 w-3.5" /> Mark Paid
                                          </Button>
                                        )}
                                        {d.status === 'DELIVERED' && <Badge variant="success">Delivered</Badge>}
                                        {canUndo(d) && (
                                          <Button size="sm" variant="ghost" className="text-rose-600 hover:bg-rose-50 hover:text-rose-700" onClick={() => setUndoTarget({ dispatch: d, order: o })}>
                                            <Undo2 className="h-3.5 w-3.5" /> Undo
                                          </Button>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Dispatch dialog */}
      <Dialog open={!!dispatchOrder} onOpenChange={(v) => !v && setDispatchOrder(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Dispatch - {dispatchOrder?.buyer?.name}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="rounded-lg border bg-muted/40 p-3 text-sm flex justify-between">
              <span className="text-muted-foreground">Remaining on this order</span>
              <span className="font-semibold">{dispatchOrder ? toTonnes(dispatchRemaining).toFixed(2) : 0} t</span>
            </div>
            <p className="text-sm text-muted-foreground">Drop the kata slip. We'll read the vehicle no and weight - edit if needed, then dispatch this lorry against the order.</p>
            <div className="space-y-1.5">
              <Label className="text-xs">Kata slip {extractingKata && <Loader2 className="inline h-3 w-3 animate-spin" />}</Label>
              <label className="flex items-center gap-2 cursor-pointer rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground hover:bg-accent">
                <Upload className="h-3.5 w-3.5" /> {kataFile ? kataFile.name.slice(0, 28) : 'Drop kata slip'}
                <input type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) { setKataFile(f); extractKata(f); } }} />
              </label>
            </div>
            <div className="space-y-1.5"><Label className="text-xs">Vehicle No</Label><Input value={vehicleNumber} onChange={(e) => setVehicleNumber(e.target.value)} placeholder="e.g. GJ05AB1234" /></div>
            <div className="space-y-1.5">
              <Label className="text-xs">Tonnage from kata (tonnes)</Label>
              <Input type="number" step="0.001" value={dispatchTonnes} onChange={(e) => setDispatchTonnes(e.target.value)} />
              <p className="text-[11px] text-muted-foreground">This actual weight bills the sale and depletes the black-seed pool.</p>
              {dispatchOverflow && (
                <p className="text-[11px] text-destructive">Exceeds the {toTonnes(dispatchRemaining).toFixed(2)} t remaining on this order.</p>
              )}
            </div>
            <DialogFooter>
              <Button onClick={() => dispatchMutation.mutate()} disabled={dispatchTonnesNum <= 0 || dispatchOverflow || dispatchMutation.isPending}>
                {dispatchMutation.isPending ? 'Dispatching…' : 'Confirm Dispatch'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {/* Undo dispatch confirmation */}
      <Dialog open={!!undoTarget} onOpenChange={(v) => !v && setUndoTarget(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Undo dispatch - {undoTarget?.order.buyer?.name}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              This reverses a dispatch made by mistake. The {undoTarget ? toTonnes(undoTarget.dispatch.weightKg).toFixed(2) : 0} t shipment will be removed,
              its sale posting reversed, and the stock it consumed returned. The order goes back to its earlier state so you can dispatch again correctly.
            </p>
            <div className="rounded-lg border bg-muted/40 p-3 text-sm space-y-1.5">
              <div className="flex justify-between"><span className="text-muted-foreground">Vehicle</span><span className="font-medium">{undoTarget?.dispatch.vehicleNumber ?? '-'}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Dispatched</span><span className="font-medium">{undoTarget ? shortDate(undoTarget.dispatch.dispatchDate) : ''} · {undoTarget ? toTonnes(undoTarget.dispatch.weightKg).toFixed(2) : 0} t</span></div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setUndoTarget(null)}>Keep dispatch</Button>
              <Button variant="destructive" onClick={() => undoMutation.mutate()} disabled={undoMutation.isPending}>
                <Undo2 className="h-4 w-4" /> {undoMutation.isPending ? 'Undoing…' : 'Undo dispatch'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {/* Raise Invoice dialog */}
      <Dialog open={!!invoiceDispatch} onOpenChange={(v) => !v && setInvoiceDispatch(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Raise Invoice - {invoiceDispatch?.order.buyer?.name}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">A tax invoice will be generated for this shipment with the next auto number.</p>
            <div className="rounded-lg border bg-muted/40 p-3 text-sm space-y-1.5">
              <div className="flex justify-between"><span className="text-muted-foreground">Base ({invoiceDispatch ? toTonnes(invoiceDispatch.dispatch.weightKg).toFixed(2) : 0} t × {rupees(invoiceDispatch?.order.ratePerKg ?? 0)})</span><span className="font-medium">{rupees(invoiceBase)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">GST (5% IGST)</span><span className="font-medium">{rupees(invoiceGst)}</span></div>
              <div className="flex justify-between border-t pt-1.5"><span className="font-semibold text-muted-foreground">Invoice value (incl. GST)</span><span className="font-bold text-emerald-600">{rupees(invoiceBase + invoiceGst)}</span></div>
            </div>
            <DialogFooter>
              <Button onClick={() => raiseInvoiceMutation.mutate()} disabled={raiseInvoiceMutation.isPending}>
                <FileText className="h-4 w-4" /> {raiseInvoiceMutation.isPending ? 'Generating…' : 'Generate Invoice'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {/* Mark Delivered dialog (buyer kata + shortage) */}
      <Dialog open={!!deliverDispatch} onOpenChange={(v) => !v && setDeliverDispatch(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Mark as Delivered - {deliverDispatch?.order.buyer?.name}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Confirm the buyer received this shipment. Enter the buyer's kata weight to auto-calculate any shortage &amp; credit note. The delivered date is set to today and the payment due date is calculated from it.
            </p>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs">Dispatched Weight</Label>
                <div className="text-sm font-semibold">{deliverDispatch ? toTonnes(deliverDispatch.dispatch.weightKg).toFixed(2) : 0} tonnes</div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Invoice Rate</Label>
                <div className="text-sm font-medium">{deliverDispatch ? rupees(deliverDispatch.order.ratePerKg) : 0}/kg + 5% GST</div>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Buyer's Kata Weight (tonnes)</Label>
              <Input type="number" step="0.001" value={buyerKataTonnes} onChange={(e) => setBuyerKataTonnes(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Buyer's Kata Slip (optional)</Label>
              <label className="flex items-center gap-2 cursor-pointer rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground hover:bg-accent">
                <Upload className="h-3.5 w-3.5" /> {deliverKataFile ? deliverKataFile.name.slice(0, 25) : 'Drop kata slip'}
                <input type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) setDeliverKataFile(f); }} />
              </label>
            </div>
            {deliverShortageKg > 0 && (
              <div className="rounded-lg border bg-amber-50/50 dark:bg-amber-950/20 p-3 text-sm space-y-1.5">
                <div className="font-semibold text-amber-700 mb-2">Shortage Recorded</div>
                <div className="flex justify-between text-amber-600"><span>Weight difference:</span><span className="font-medium">−{deliverShortageKg} kg</span></div>
                <div className="text-xs text-amber-600/80 mt-1">Shortages are saved but will not reduce the invoice value automatically. Adjust them at the time of payment receipt.</div>
              </div>
            )}
            {deliverShortageKg === 0 && buyerKataKg > 0 && !deliverOverweight && (
              <div className="rounded-lg border bg-emerald-50/50 p-3 text-sm text-emerald-700 font-medium text-center">Weights match. No credit note needed.</div>
            )}
            {deliverOverweight && (
              <div className="rounded-lg border bg-rose-50/50 p-3 text-sm text-rose-700 font-medium text-center">Buyer weight cannot exceed dispatched weight.</div>
            )}
            <DialogFooter>
              <Button onClick={() => deliverMutation.mutate()} disabled={deliverMutation.isPending || deliverOverweight} variant="forest">
                <PackageCheck className="h-4 w-4" /> {deliverMutation.isPending ? 'Saving…' : 'Confirm Delivered'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {/* E-Way Bill Dialog */}
      <Dialog open={!!ewbDispatch} onOpenChange={(v) => !v && setEwbDispatch(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Generate E-Way Bill - {ewbDispatch?.order.buyer?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-lg border bg-muted/40 p-3 text-sm flex flex-col gap-1">
              <div className="flex justify-between"><span className="text-muted-foreground">IRN Ack No</span><span className="font-semibold text-indigo-600 font-mono">{ewbDispatch?.dispatch.irnAckNo || 'ACTIVE'}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Vehicle Number</span><span className="font-semibold">{ewbDispatch?.dispatch.vehicleNumber || 'Not specified'}</span></div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Transport Mode *</Label>
                <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={transMode} onChange={(e) => setTransMode(e.target.value)}>
                  <option value="1">Road</option>
                  <option value="2">Rail</option>
                  <option value="3">Air</option>
                  <option value="4">Ship</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Distance (km) *</Label>
                <Input type="number" min="0" value={transDistance} onChange={(e) => setTransDistance(e.target.value)} placeholder="e.g. 250" />
                <p className="text-[11px] text-muted-foreground">Enter 0 to let the portal auto-calculate from PIN codes.</p>
              </div>

              {transMode === '1' ? (
                <>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Vehicle Number *</Label>
                    <Input value={ewbVehicleNo} onChange={(e) => setEwbVehicleNo(e.target.value)} placeholder="e.g. AP03XX1234" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Vehicle Type *</Label>
                    <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={vehicleType} onChange={(e) => setVehicleType(e.target.value)}>
                      <option value="R">Regular</option>
                      <option value="O">Over Dimensional Cargo</option>
                    </select>
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Transport Document No *</Label>
                    <Input value={transDocNo} onChange={(e) => setTransDocNo(e.target.value)} placeholder="LR / RR / Airway bill no" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Transport Document Date *</Label>
                    <Input type="date" value={transDocDt} onChange={(e) => setTransDocDt(e.target.value)} />
                  </div>
                </>
              )}

              <div className="space-y-1.5">
                <Label className="text-xs">Transporter GSTIN/ID (optional)</Label>
                <Input
                  value={transporterId}
                  onChange={(e) => setTransporterId(e.target.value.toUpperCase())}
                  placeholder="e.g. 27AAAAA1111A1Z1"
                  className={transporterIdInvalid ? 'border-destructive' : undefined}
                />
                {transporterIdInvalid && (
                  <p className="text-[11px] text-destructive">Must be a valid 15-character GSTIN, or leave blank.</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Transporter Name (optional)</Label>
                <Input value={transporterName} onChange={(e) => setTransporterName(e.target.value)} placeholder="Surya Roadlines" />
              </div>
            </div>

            <DialogFooter>
              <Button
                onClick={() => generateEwbMutation.mutate()}
                disabled={
                  generateEwbMutation.isPending ||
                  transDistance === '' ||
                  transporterIdInvalid ||
                  (transMode === '1' ? !ewbVehicleNo.trim() : (!transDocNo.trim() || !transDocDt))
                }
              >
                {generateEwbMutation.isPending ? 'Generating...' : 'Generate E-Way Bill'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {/* Cancel Dialog (Shared for IRN and EWB) */}
      <Dialog open={!!cancelTarget} onOpenChange={(v) => !v && setCancelTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel {cancelTarget?.type === 'einvoice' ? 'E-Invoice (IRN)' : 'E-Way Bill'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Are you sure you want to cancel the generated {cancelTarget?.type === 'einvoice' ? 'E-Invoice' : 'E-Way Bill'}? This action is reported to the government portal.
            </p>
            <div className="space-y-1.5">
              <Label className="text-xs">Cancellation Reason Code</Label>
              <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)}>
                {cancelTarget?.type === 'einvoice' ? (
                  <>
                    <option value="1">1 - Duplicate</option>
                    <option value="2">2 - Data Entry Mistake</option>
                    <option value="3">3 - Order Cancelled</option>
                    <option value="4">4 - Others</option>
                  </>
                ) : (
                  <>
                    <option value="1">1 - Duplicate</option>
                    <option value="2">2 - Order Cancelled</option>
                    <option value="3">3 - Mistake in EWB</option>
                    <option value="4">4 - Others</option>
                  </>
                )}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Cancellation Remarks</Label>
              <textarea
                value={cancelRemarks}
                onChange={(e) => setCancelRemarks(e.target.value)}
                rows={3}
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="Explain the reason for cancellation..."
              />
            </div>
            <DialogFooter>
              <Button
                variant="destructive"
                onClick={() => cancelTarget?.type === 'einvoice' ? cancelIrnMutation.mutate() : cancelEwbMutation.mutate()}
                disabled={cancelIrnMutation.isPending || cancelEwbMutation.isPending}
              >
                {cancelIrnMutation.isPending || cancelEwbMutation.isPending ? 'Cancelling...' : 'Confirm Cancellation'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {/* Payment Dialog */}
      <Dialog open={!!payDispatch} onOpenChange={(v) => !v && setPayDispatch(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Mark as Paid - {payDispatch?.order.buyer?.name}</DialogTitle>
          </DialogHeader>
          
          {payDispatch && (() => {
            const d = payDispatch.dispatch;
            const o = payDispatch.order;
            const invoiceBase = d.weightKg * Number(o.ratePerKg);
            const invoiceGst = Math.round(invoiceBase * GST_RATE * 100) / 100;
            const invoiceTotal = invoiceBase + invoiceGst;

            return (
              <div className="space-y-4">
                <div className="rounded-lg border bg-muted/30 p-3 space-y-1.5 text-sm">
                  <div className="flex justify-between text-muted-foreground">
                    <span>Invoice Total</span>
                    <span className="font-medium text-foreground">{rupees(invoiceTotal)}</span>
                  </div>
                  {Number(payShortage) > 0 && (
                    <div className="flex justify-between text-amber-600 dark:text-amber-500">
                      <span>Shortage Deduction</span>
                      <span>-{rupees(Number(payShortage))}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-semibold border-t pt-1.5 border-border">
                    <span>Net Due</span>
                    <span>{rupees(invoiceTotal - (Number(payShortage) || 0))}</span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label>Payment Date</Label>
                    <Input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Amount Received</Label>
                    <div className="relative">
                      <div className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">₹</div>
                      <Input type="number" step="0.01" className="pl-7" value={payAmount} onChange={(e) => handlePayAmountChange(e.target.value)} />
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label>Shortage Deduction</Label>
                    <div className="relative">
                      <div className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">₹</div>
                      <Input type="number" step="0.01" className="pl-7" value={payShortage} onChange={(e) => handlePayShortageChange(e.target.value)} placeholder="0" />
                    </div>
                    <p className="text-[11px] text-muted-foreground">Any quality/weight shortage claim by buyer.</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label>TDS Deducted (0.1%)</Label>
                    <div className="relative">
                      <div className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">₹</div>
                      <Input type="number" step="0.01" className="pl-7" value={payTds} onChange={(e) => setPayTds(e.target.value)} placeholder="0" />
                    </div>
                    <p className="text-[11px] text-muted-foreground">Auto-calc if received amount is less than expected net.</p>
                  </div>
                </div>
              </div>
            );
          })()}
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayDispatch(null)}>Cancel</Button>
            <Button onClick={() => payMutation.mutate()} disabled={payMutation.isPending || !payAmount}>
              {payMutation.isPending ? 'Saving...' : 'Record Payment'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Label + mono value (+ optional sub-line) used in the profitability breakdown. */
/**
 * Rich per-order Pappu P/L panel shown inside the expanded row: a P/L headline,
 * a "where the revenue goes" composition bar, accent-bordered cost tiles, and the
 * date-aware black-seed allocation chips.
 */
function PappuMarginPanel({ margin }: { margin: PappuMargin }) {
  const isProfit = margin.margin >= 0;
  const pnlText = isProfit ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400';

  // Bar denominator = whichever is larger, so both profit and loss orders fill it.
  const costs = margin.freight + margin.brokerage + margin.seedCost + margin.prodCost;
  const denom = Math.max(margin.revenue, costs, 1);
  const width = (v: number) => `${(v / denom) * 100}%`;

  const segments = [
    { key: 'seed', label: 'Black seed', value: margin.seedCost, color: 'bg-amber-500' },
    { key: 'prod', label: 'Production', value: margin.prodCost, color: 'bg-orange-400' },
    { key: 'freight', label: 'Freight', value: margin.freight, color: 'bg-slate-400' },
    { key: 'brokerage', label: 'Brokerage', value: margin.brokerage, color: 'bg-violet-400' },
    ...(isProfit ? [{ key: 'margin', label: 'Margin', value: margin.margin, color: 'bg-emerald-500' }] : []),
  ].filter((s) => s.value > 0);

  return (
    <div className="mb-4 overflow-hidden rounded-2xl border border-border/70 bg-card/70 shadow-sm">
      {/* Headline */}
      <div className={cn('flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-3', isProfit ? 'bg-emerald-500/[0.06]' : 'bg-rose-500/[0.06]')}>
        <div className="flex items-center gap-3">
          <div className={cn('flex h-10 w-10 items-center justify-center rounded-xl', isProfit ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-rose-500/15 text-rose-600 dark:text-rose-400')}>
            {isProfit ? <TrendingUp className="h-5 w-5" /> : <TrendingDown className="h-5 w-5" />}
          </div>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{isProfit ? 'Profit' : 'Loss'} · this order</div>
            <div className={cn('font-mono text-xl font-extrabold leading-tight tabular-nums', pnlText)}>{isProfit ? '+' : ''}{rupees(margin.margin)}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="rounded-lg border border-border/60 bg-background/70 px-3 py-1.5 text-center">
            <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">Margin</div>
            <div className={cn('font-mono text-sm font-bold tabular-nums', pnlText)}>{margin.marginPct}%</div>
          </div>
          <div className="rounded-lg border border-border/60 bg-background/70 px-3 py-1.5 text-center">
            <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">Per kg</div>
            <div className={cn('font-mono text-sm font-bold tabular-nums', pnlText)}>{rupees(margin.marginPerKg)}</div>
          </div>
        </div>
      </div>

      {/* Composition bar */}
      <div className="px-4 pt-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Where the revenue goes</span>
          <span className="font-mono text-[11px] font-semibold tabular-nums text-foreground/70">{rupees(margin.revenue)} revenue</span>
        </div>
        <div className="flex h-3.5 w-full gap-0.5 overflow-hidden rounded-full bg-muted">
          {segments.map((s) => (
            <div key={s.key} className={cn('h-full', s.color)} style={{ width: width(s.value) }} title={`${s.label}: ${rupees(s.value)}`} />
          ))}
        </div>
        <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
          {segments.map((s) => (
            <div key={s.key} className="flex items-center gap-1.5">
              <span className={cn('h-2 w-2 rounded-full', s.color)} />
              <span className="text-[10px] font-medium text-muted-foreground">{s.label}</span>
              <span className="font-mono text-[10px] font-semibold tabular-nums text-foreground/80">{rupees(s.value)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Cost tiles */}
      <div className="grid grid-cols-2 gap-2.5 px-4 py-4 sm:grid-cols-3 lg:grid-cols-4">
        <PnlTile accent="bg-sky-500" label="Sale price" value={`${rupees(margin.ratePerKg)}/kg`} sub={`${rupees(margin.revenue)} · incl. freight`} />
        <PnlTile accent="bg-slate-400" label="− Freight" value={`${rupees(margin.freightPerKg)}/kg`} sub={`${rupees(margin.freight)} netted out`} />
        {margin.brokerage > 0 && <PnlTile accent="bg-violet-400" label="− Brokerage" value={rupees(margin.brokerage)} />}
        <PnlTile accent="bg-indigo-500" label="= Net realisation" value={rupees(margin.netRealization)} emphasis />
        <PnlTile accent="bg-amber-500" label="− Black seed cost" value={`${rupees(margin.seedCostPerPappuKg)}/kg`} sub={`${rupees(margin.seedCost)} · WAC ${rupees(margin.seedWacPerKg)}/kg`} />
        {margin.prodCost > 0 && <PnlTile accent="bg-orange-400" label="− Production" value={`${rupees(margin.prodCostPerKg)}/kg`} sub={rupees(margin.prodCost)} />}
        <PnlTile accent={isProfit ? 'bg-emerald-500' : 'bg-rose-500'} label={isProfit ? 'Net margin' : 'Net loss'} value={rupees(margin.margin)} sub={`${margin.marginPct}% · ${rupees(margin.marginPerKg)}/kg`} emphasis valueClass={pnlText} />
      </div>

      {/* Date-aware seed allocation */}
      {margin.seedBands.length > 0 && (
        <div className="border-t border-border/60 bg-muted/30 px-4 py-3">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Black seed allocated · date-aware (dearest available at sale date)</span>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {margin.seedBands.map((b, i) => (
              <span key={i} className="inline-flex items-center gap-1.5 rounded-lg border border-amber-200/70 bg-amber-50 px-2.5 py-1 font-mono text-[10px] text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
                <span className="font-semibold">{toTonnes(b.seedKg).toFixed(2)}t</span>
                <span className="opacity-60">@</span>
                {rupees(b.price)}/kg
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Accent-bordered figure tile used in the Pappu P/L panel. */
function PnlTile({ accent, label, value, sub, emphasis, valueClass }: { accent: string; label: string; value: string; sub?: string; emphasis?: boolean; valueClass?: string }) {
  return (
    <div className={cn('relative overflow-hidden rounded-xl border p-3', emphasis ? 'border-border bg-background shadow-sm' : 'border-border/60 bg-background/60')}>
      <span className={cn('absolute inset-y-0 left-0 w-1', accent)} />
      <div className="pl-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className={cn('mt-1 font-mono text-sm font-bold tabular-nums', valueClass)}>{value}</div>
        {sub && <div className="mt-0.5 font-mono text-[10px] text-muted-foreground/80">{sub}</div>}
      </div>
    </div>
  );
}

/** Compact label + mono figure used inside the shipment panel. */
function Figure({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="text-right">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 font-mono text-sm font-semibold tabular-nums', valueClass)}>{value}</div>
    </div>
  );
}
