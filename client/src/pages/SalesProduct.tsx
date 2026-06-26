import { Fragment, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Truck, PackageCheck, Upload, Loader2, FileText, Printer, ChevronRight, ShoppingCart, CalendarClock } from 'lucide-react';
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

const GST_RATE = 0.05;

const PRODUCT_META: Record<SaleProduct, { title: string; noun: string }> = {
  PAPPU: { title: 'Pappu Sales', noun: 'Pappu' },
  HUSK: { title: 'Husk Sales', noun: 'Husk' },
  WASTE: { title: 'Tamarind Waste Sales', noun: 'Tamarind Waste' },
  TPS: { title: 'TPS (Brokens) Sales', noun: 'TPS (Brokens)' },
  SHELL: { title: 'Tamarind Shell Sales', noun: 'Tamarind Shell' },
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

/** Dispatched (sum of shipments) — falls back to summing if the server field is absent. */
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

  const hasBroker = !['WASTE', 'TPS', 'SHELL'].includes(product);
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
  const [internalWeightTonnes, setInternalWeightTonnes] = useState('');
  const [extractingKata, setExtractingKata] = useState(false);

  const dispatchRemaining = dispatchOrder ? remainingKgOf(dispatchOrder) : 0;
  const dispatchTonnesNum = Number(dispatchTonnes) || 0;
  const dispatchOverflow = dispatchOrder ? Math.round(dispatchTonnesNum * 1000) > dispatchRemaining : false;

  function openDispatch(o: SaleOrder) {
    setDispatchOrder(o);
    setKataFile(null);
    setVehicleNumber('');
    setDispatchTonnes(String(remainingKgOf(o) / 1000));
    setInternalWeightTonnes('');
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
      toast.success('Read kata slip — fields pre-filled');
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
      if (internalWeightTonnes) fd.append('internalWeightKg', String(Math.round((Number(internalWeightTonnes) || 0) * 1000)));
      return api(`/sale-orders/${dispatchOrder!.id}/dispatch`, { method: 'POST', body: fd, multipart: true });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sale-orders'] });
      qc.invalidateQueries({ queryKey: ['black-seed-stock'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success('Dispatched — raise the invoice when ready');
      setDispatchOrder(null);
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
  const invoiceCn = Number(invoiceDispatch?.dispatch.creditNoteAmount || 0);
  const invoiceNet = invoiceBase + invoiceGst - invoiceCn;

  // ── Mark Delivered dialog (captures buyer kata + shortage) ───────────────────
  const [deliverDispatch, setDeliverDispatch] = useState<{ dispatch: SaleDispatch; order: SaleOrder } | null>(null);
  const [deliverKataFile, setDeliverKataFile] = useState<File | null>(null);
  const [buyerKataTonnes, setBuyerKataTonnes] = useState('');

  function openDeliver(dispatch: SaleDispatch, order: SaleOrder) {
    setDeliverDispatch({ dispatch, order });
    setDeliverKataFile(null);
    setBuyerKataTonnes(String(dispatch.weightKg / 1000));
  }

  const deliverRate = deliverDispatch ? Number(deliverDispatch.order.ratePerKg) : 0;
  const buyerKataKg = Math.round((Number(buyerKataTonnes) || 0) * 1000);
  const deliverShortageKg = deliverDispatch ? Math.max(0, deliverDispatch.dispatch.weightKg - buyerKataKg) : 0;
  const deliverOverweight = deliverDispatch ? buyerKataKg > deliverDispatch.dispatch.weightKg : false;
  const deliverCreditAmount = deliverShortageKg * deliverRate * (1 + GST_RATE);

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

  // ── E-Invoice / E-Way Bill (TaxPro GSP) actions ───────────────────────────
  const [ewbDispatch, setEwbDispatch] = useState<{ dispatch: SaleDispatch; order: SaleOrder } | null>(null);
  const [transporterId, setTransporterId] = useState('');
  const [transporterName, setTransporterName] = useState('');
  const [transDistance, setTransDistance] = useState('100');
  const [transMode, setTransMode] = useState('1');
  const [ewbVehicleNo, setEwbVehicleNo] = useState('');
  const [vehicleType, setVehicleType] = useState('R');

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
    setTransDistance('100');
    setTransMode('1');
    setEwbVehicleNo(dispatch.vehicleNumber || '');
    setVehicleType('R');
  }

  function openCancel(id: string, type: 'einvoice' | 'ewaybill') {
    setCancelTarget({ id, type });
    setCancelReason(type === 'einvoice' ? '2' : '3');
    setCancelRemarks('Cancelled from ERP');
  }

  // ── Full workflow view ────────────────────────────────────────────────
  const filtersActive = statusFilter !== 'ALL' || partyFilter !== 'ALL' || brokerFilter !== 'ALL' || !!fromDate || !!toDate;

  return (
    <div className="space-y-6">
      {!hideHeader && (
        <PageHeader
          icon={ShoppingCart}
          title={meta.title}
          description={`Manage the full ${meta.noun.toLowerCase()} lifecycle — dispatch lorries against each order, invoice every shipment, and mark delivered.`}
        />
      )}

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
              return (
                <Fragment key={o.id}>
                  {/* Order row — click to expand its shipments */}
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
                    <TableCell className="font-medium text-foreground">{o.buyer?.name ?? '—'}</TableCell>
                    {hasBroker && <TableCell className="text-muted-foreground">{o.broker?.name ?? '—'}</TableCell>}
                    <TableCell className="text-muted-foreground">{o.destination ?? '—'}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums font-medium">{toTonnes(o.tonnageKg).toFixed(2)} t</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{toTonnes(dispatchedKg).toFixed(2)} t</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {remainingKg > 0
                        ? <span className="text-amber-600 dark:text-amber-400">{toTonnes(remainingKg).toFixed(2)} t</span>
                        : <span className="text-emerald-600 dark:text-emerald-400">0.00 t</span>}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{rupees(o.ratePerKg)}</TableCell>
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
                                const cnAmt = Number(d.creditNoteAmount || 0);
                                const netDue = (d.weightKg * Number(o.ratePerKg) * (1 + GST_RATE)) - cnAmt;
                                const tds = d.weightKg * Number(o.ratePerKg) * 0.001;
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
                                            {d.internalWeightKg != null && (
                                              <>
                                                <span className="opacity-40">·</span>
                                                <span className="font-mono text-emerald-600 dark:text-emerald-400">{toTonnes(d.internalWeightKg).toFixed(2)} t internal</span>
                                              </>
                                            )}
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
                                        {isPappu && <Figure label="TDS 0.1%" value={rupees(tds)} valueClass="text-rose-600 dark:text-rose-400" />}
                                        {cnAmt > 0 && <Figure label="Credit note" value={`−${rupees(cnAmt)}`} valueClass="text-destructive" />}
                                        <div className="text-right">
                                          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Due</div>
                                          <div className="mt-0.5 flex items-center justify-end gap-1 text-sm font-medium">
                                            {dueIso ? (
                                              <span className={overdue ? 'text-destructive' : soon ? 'text-amber-600 dark:text-amber-400' : ''}>
                                                {overdue && <CalendarClock className="mr-0.5 inline h-3.5 w-3.5" />}
                                                {shortDate(dueIso)}{o.dueDays != null ? ` · ${o.dueDays}d` : ''}
                                              </span>
                                            ) : <span className="text-muted-foreground">—</span>}
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
                                              <Button size="sm" variant="outline" className="border-rose-200 text-rose-700 hover:bg-rose-50" onClick={() => openCancel(d.id, 'ewaybill')}>
                                                Cancel EWB
                                              </Button>
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
                                        {d.status === 'DELIVERED' && <Badge variant="success">Delivered</Badge>}
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
          <DialogHeader><DialogTitle>Dispatch — {dispatchOrder?.buyer?.name}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="rounded-lg border bg-muted/40 p-3 text-sm flex justify-between">
              <span className="text-muted-foreground">Remaining on this order</span>
              <span className="font-semibold">{dispatchOrder ? toTonnes(dispatchRemaining).toFixed(2) : 0} t</span>
            </div>
            <p className="text-sm text-muted-foreground">Drop the kata slip. We'll read the vehicle no and weight — edit if needed, then dispatch this lorry against the order.</p>
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
            {dispatchOrder?.product === 'PAPPU' && (
              <div className="space-y-1.5 border-t border-border pt-3 mt-3">
                <Label className="text-xs">Internal Weight (tonnes)</Label>
                <Input type="number" step="0.001" value={internalWeightTonnes} onChange={(e) => setInternalWeightTonnes(e.target.value)} placeholder="Auto-calculated if left blank" />
                <p className="text-[11px] text-muted-foreground">Actual weight without moisture gain. Leave blank to auto-calculate (e.g. 25t = 150kg short).</p>
              </div>
            )}
            <DialogFooter>
              <Button onClick={() => dispatchMutation.mutate()} disabled={dispatchTonnesNum <= 0 || dispatchOverflow || dispatchMutation.isPending}>
                {dispatchMutation.isPending ? 'Dispatching…' : 'Confirm Dispatch'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {/* Raise Invoice dialog */}
      <Dialog open={!!invoiceDispatch} onOpenChange={(v) => !v && setInvoiceDispatch(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Raise Invoice — {invoiceDispatch?.order.buyer?.name}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">A tax invoice will be generated for this shipment with the next auto number.</p>
            <div className="rounded-lg border bg-muted/40 p-3 text-sm space-y-1.5">
              <div className="flex justify-between"><span className="text-muted-foreground">Base ({invoiceDispatch ? toTonnes(invoiceDispatch.dispatch.weightKg).toFixed(2) : 0} t × {rupees(invoiceDispatch?.order.ratePerKg ?? 0)})</span><span className="font-medium">{rupees(invoiceBase)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">GST (5% IGST)</span><span className="font-medium">{rupees(invoiceGst)}</span></div>
              {invoiceCn > 0 && <div className="flex justify-between text-rose-600"><span>Shortage CN (separate)</span><span>−{rupees(invoiceCn)}</span></div>}
              <div className="flex justify-between border-t pt-1.5"><span className="font-semibold text-muted-foreground">Invoice value (incl. GST)</span><span className="font-bold text-emerald-600">{rupees(invoiceBase + invoiceGst)}</span></div>
              {invoiceCn > 0 && <div className="flex justify-between text-xs text-muted-foreground"><span>Net receivable after CN</span><span>{rupees(invoiceNet)}</span></div>}
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
          <DialogHeader><DialogTitle>Mark as Delivered — {deliverDispatch?.order.buyer?.name}</DialogTitle></DialogHeader>
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
              <div className="rounded-lg border bg-rose-50/50 dark:bg-rose-950/20 p-3 text-sm space-y-1.5">
                <div className="font-semibold text-rose-700 mb-2">Shortage Detected</div>
                <div className="flex justify-between text-rose-600"><span>Weight difference:</span><span className="font-medium">−{deliverShortageKg} kg</span></div>
                <div className="flex justify-between text-rose-600"><span>Value loss (base):</span><span className="font-medium">−{rupees(deliverShortageKg * deliverRate)}</span></div>
                <div className="flex justify-between border-t border-rose-200 pt-1.5 font-semibold text-rose-700"><span>Auto credit note (incl. GST)</span><span>{rupees(deliverCreditAmount)}</span></div>
              </div>
            )}
            {deliverDispatch?.dispatch.internalWeightKg && deliverDispatch.order.product === 'PAPPU' && buyerKataKg > deliverDispatch.dispatch.internalWeightKg && (
              <div className="rounded-lg border bg-emerald-50/50 dark:bg-emerald-950/20 p-3 text-sm space-y-1.5">
                <div className="font-semibold text-emerald-700 mb-2">Moisture Gain Profit</div>
                <div className="flex justify-between text-emerald-600"><span>Weight gained:</span><span className="font-medium">+{buyerKataKg - deliverDispatch.dispatch.internalWeightKg} kg</span></div>
                <div className="flex justify-between border-t border-emerald-200 pt-1.5 font-semibold text-emerald-700"><span>Profit to record</span><span>{rupees((buyerKataKg - deliverDispatch.dispatch.internalWeightKg) * deliverRate)}</span></div>
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
                <PackageCheck className="h-4 w-4" /> {deliverMutation.isPending ? 'Saving…' : deliverShortageKg > 0 ? 'Confirm Delivered & Raise CN' : 'Confirm Delivered'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {/* E-Way Bill Dialog */}
      <Dialog open={!!ewbDispatch} onOpenChange={(v) => !v && setEwbDispatch(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Generate E-Way Bill — {ewbDispatch?.order.buyer?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-lg border bg-muted/40 p-3 text-sm flex flex-col gap-1">
              <div className="flex justify-between"><span className="text-muted-foreground">IRN Ack No</span><span className="font-semibold text-indigo-600 font-mono">{ewbDispatch?.dispatch.irnAckNo || 'ACTIVE'}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Vehicle Number</span><span className="font-semibold">{ewbDispatch?.dispatch.vehicleNumber || 'Not specified'}</span></div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Transporter GSTIN/ID (optional)</Label>
                <Input value={transporterId} onChange={(e) => setTransporterId(e.target.value)} placeholder="e.g. 27AAAAA1111A1Z1" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Transporter Name (optional)</Label>
                <Input value={transporterName} onChange={(e) => setTransporterName(e.target.value)} placeholder="Surya Roadlines" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Distance (in Km) *</Label>
                <Input type="number" value={transDistance} onChange={(e) => setTransDistance(e.target.value)} placeholder="e.g. 250" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Transport Mode</Label>
                <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={transMode} onChange={(e) => setTransMode(e.target.value)}>
                  <option value="1">Road</option>
                  <option value="2">Rail</option>
                  <option value="3">Air</option>
                  <option value="4">Ship</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Vehicle Number (if different)</Label>
                <Input value={ewbVehicleNo} onChange={(e) => setEwbVehicleNo(e.target.value)} placeholder="e.g. AP03XX1234" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Vehicle Type</Label>
                <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={vehicleType} onChange={(e) => setVehicleType(e.target.value)}>
                  <option value="R">Regular</option>
                  <option value="O">Over Dimensional Cargo</option>
                </select>
              </div>
            </div>

            <DialogFooter>
              <Button onClick={() => generateEwbMutation.mutate()} disabled={generateEwbMutation.isPending || !transDistance}>
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
