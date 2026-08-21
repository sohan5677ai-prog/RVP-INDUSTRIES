import { useState, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Table2, ClipboardList } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { BulkImportDialog } from '@/components/BulkImportDialog';
import { PageHeader } from '@/components/PageHeader';
import type { Party, Broker, SaleOrder, SaleStatus, SaleProduct, Commodity, Receipt } from '@/lib/types';
import { SALE_STATUS_VARIANT, saleDisplayStatus, saleStatusLabel, settledByDispatch } from '@/lib/saleStatus';
import { rupees, shortDate, toTonnes } from '@/lib/format';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Form, FormControl, FormField, FormItem, FormLabel, FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Combobox } from '@/components/ui/combobox';
import { Badge } from '@/components/ui/badge';
import { PaginationBar } from '@/components/ui/pagination-bar';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';
import { usePagedRows } from '@/lib/usePagedRows';

const GST_RATE = 0.05;

const PRODUCTS: { value: SaleProduct; label: string }[] = [
  { value: 'PAPPU', label: 'Pappu' },
  { value: 'HUSK', label: 'Husk' },
  { value: 'WASTE', label: 'Tamarind Waste' },
  { value: 'TPS', label: 'TPS (Brokens)' },
  { value: 'SHELL', label: 'Tamarind Shell' },
  { value: 'PRECLEANER_DUST', label: 'Pre Cleaner Dust' },
  { value: 'NALLA_POKKULU', label: 'Nalla Pokkulu' },
  { value: 'NALLA_CHINTAPANDU', label: 'Nalla Chintapandu' },
];

const PRODUCT_TO_COMMODITY: Record<SaleProduct, Commodity> = {
  PAPPU: 'PAPPU',
  HUSK: 'HUSK',
  WASTE: 'TAMARIND_WASTE',
  TPS: 'TPS_BROKENS',
  SHELL: 'TAMARIND_SHELL',
  PRECLEANER_DUST: 'PRECLEANER_DUST',
  NALLA_POKKULU: 'NALLA_POKKULU',
  NALLA_CHINTAPANDU: 'NALLA_CHINTAPANDU',
};

const STATUS_FILTERS: ('ALL' | SaleStatus)[] = ['ALL', 'PENDING', 'PARTIAL', 'DISPATCHED'];

// Payment-status tabs, keyed off receipts (not the lifecycle status). "Received"
// = every shipment fully paid; "Pending" = any balance still outstanding.
type PayFilter = 'ALL' | 'RECEIVED' | 'PENDING';
const PAY_FILTERS: { value: PayFilter; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'RECEIVED', label: 'Received' },
  { value: 'PENDING', label: 'Pending' },
];

const NO_BROKER = '__none__';

const saleSchema = z.object({
  saleDate: z.string().min(1, 'Date is required'),
  product: z.enum(['PAPPU', 'HUSK', 'WASTE', 'TPS', 'SHELL', 'PRECLEANER_DUST', 'NALLA_POKKULU', 'NALLA_CHINTAPANDU']),
  buyerId: z.string().min(1, 'Party is required'),
  buyerAddressId: z.string().optional(),
  poNumber: z.string().optional(),
  poDate: z.string().optional(),
  brokerId: z.string().optional(),
  tonnes: z.string().min(1, 'Tonnage is required').refine((v) => Number(v) > 0, 'Must be positive'),
  ratePerKg: z.string().min(1, 'Price is required').refine((v) => Number(v) > 0, 'Must be positive'),
  dueDays: z.string().optional().refine((v) => !v || Number(v) >= 0, 'Must be 0 or more'),
  reminderDate: z.string().optional(),
});
type SaleForm = z.infer<typeof saleSchema>;

export default function SaleOrders() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [editing, setEditing] = useState<SaleOrder | null>(null);
  const [statusFilter, setStatusFilter] = useState<'ALL' | SaleStatus>('ALL');
  const [payFilter, setPayFilter] = useState<PayFilter>('ALL');
  const [productFilter, setProductFilter] = useState<'ALL' | SaleProduct>('ALL');
  const [brokerFilter, setBrokerFilter] = useState<string>('ALL');
  const [partyFilter, setPartyFilter] = useState<string>('ALL');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [override, setOverride] = useState(false);
  const [gstExempt, setGstExempt] = useState(false);
  // Base (ex-works, buyer's lorry) vs delivery (our freight). Pappu is always
  // delivered; husk & the byproducts are usually base, so the default follows
  // the product and the user only flips it for the occasional delivered deal.
  const [priceType, setPriceType] = useState<'BASE' | 'DELIVERY'>('DELIVERY');

  const { data: orders, isLoading } = useQuery({ queryKey: ['sale-orders'], queryFn: () => api<SaleOrder[]>('/sale-orders') });
  const { data: parties } = useQuery({ queryKey: ['parties'], queryFn: () => api<Party[]>('/parties') });
  const { data: brokers } = useQuery({ queryKey: ['brokers'], queryFn: () => api<Broker[]>('/brokers') });
  const { data: receipts } = useQuery({ queryKey: ['receipts'], queryFn: () => api<Receipt[]>('/receipts?all=true') });
  const settled = useMemo(() => settledByDispatch(receipts), [receipts]);

  const filtered = (orders ?? []).filter((o) => {
    if (statusFilter !== 'ALL' && o.status !== statusFilter) return false;
    if (payFilter !== 'ALL') {
      const received = saleDisplayStatus(o, settled) === 'PAID';
      if (payFilter === 'RECEIVED' && !received) return false;
      if (payFilter === 'PENDING' && received) return false;
    }
    if (productFilter !== 'ALL' && o.product !== productFilter) return false;
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
  const { page, setPage, pageSize, setPageSize, totalPages, total, pageRows: visible = [] } = usePagedRows(filtered, 50);

  const exportColumns: ExportColumn<SaleOrder>[] = [
    { header: 'Date', value: (o) => shortDate(o.saleDate) },
    { header: 'PO No.', value: (o) => o.poNumber ?? '' },
    { header: 'Commodity', value: (o) => PRODUCTS.find((p) => p.value === o.product)?.label ?? o.product },
    { header: 'Party', value: (o) => o.buyer?.name ?? '' },
    { header: 'Broker', value: (o) => o.broker?.name ?? '' },
    { header: 'Destination', value: (o) => o.destination ?? '' },
    { header: 'Price Basis', value: (o) => (o.priceType === 'DELIVERY' ? 'Delivery' : 'Base') },
    { header: 'Ordered (t)', value: (o) => toTonnes(o.tonnageKg).toFixed(2), excel: (o) => toTonnes(o.tonnageKg), numFmt: '#,##0.00', align: 'right' },
    { header: 'Dispatched (t)', value: (o) => toTonnes(o.dispatchedKg ?? 0).toFixed(2), excel: (o) => toTonnes(o.dispatchedKg ?? 0), numFmt: '#,##0.00', align: 'right' },
    { header: 'Remaining (t)', value: (o) => toTonnes(o.remainingKg ?? o.tonnageKg).toFixed(2), excel: (o) => toTonnes(o.remainingKg ?? o.tonnageKg), numFmt: '#,##0.00', align: 'right' },
    // Booked but never shipped, on an order that was closed short.
    { header: 'Short (t)', value: (o) => toTonnes(o.shortKg ?? 0).toFixed(2), excel: (o) => toTonnes(o.shortKg ?? 0), numFmt: '#,##0.00', align: 'right' },
    { header: 'Price/kg', value: (o) => rupees(o.ratePerKg), excel: (o) => Number(o.ratePerKg), numFmt: '#,##0.00', align: 'right' },
    { header: 'Status', value: (o) => saleStatusLabel(saleDisplayStatus(o, settled)) },
  ];

  const form = useForm<SaleForm>({
    resolver: zodResolver(saleSchema),
    defaultValues: {
      saleDate: new Date().toISOString().slice(0, 10),
      product: 'PAPPU',
      buyerId: '',
      buyerAddressId: '',
      poNumber: '',
      poDate: '',
      brokerId: NO_BROKER,
      tonnes: '',
      ratePerKg: '',
      dueDays: '',
      reminderDate: '',
    },
  });

  const watchedProduct = form.watch('product');
  const buyerId = form.watch('buyerId');
  const watchedBuyerAddressId = form.watch('buyerAddressId');
  const tonnes = Number(form.watch('tonnes')) || 0;
  const weightKg = Math.round(tonnes * 1000);
  const rate = Number(form.watch('ratePerKg')) || 0;
  const base = weightKg * rate;
  const gst = gstExempt ? 0 : Math.round(base * GST_RATE * 100) / 100;
  const value = base + gst;
  const currentBuyer = parties?.find((p) => p.id === buyerId);
  const activeSelectedAddr = currentBuyer?.addresses?.find((a) => a.id === watchedBuyerAddressId) || currentBuyer?.addresses?.find((a) => a.isDefault) || currentBuyer?.addresses?.[0];
  const buyerDestination = activeSelectedAddr?.destination || currentBuyer?.destination || null;

  function openCreate() {
    setEditing(null);
    setOverride(false);
    setGstExempt(false);
    setPriceType('DELIVERY'); // create always starts on Pappu
    form.reset({
      saleDate: new Date().toISOString().slice(0, 10),
      product: 'PAPPU',
      buyerId: '',
      buyerAddressId: '',
      poNumber: '',
      poDate: '',
      brokerId: NO_BROKER,
      tonnes: '',
      ratePerKg: '',
      dueDays: '',
      reminderDate: '',
    });
    setOpen(true);
  }

  function openEdit(o: SaleOrder) {
    setEditing(o);
    setOverride(o.marginOverride);
    setGstExempt(o.gstExempt);
    setPriceType(o.priceType ?? 'DELIVERY');
    form.reset({
      saleDate: o.saleDate.slice(0, 10),
      product: o.product,
      buyerId: o.buyerId,
      buyerAddressId: o.buyerAddressId ?? '',
      poNumber: o.poNumber ?? '',
      poDate: o.poDate ? o.poDate.slice(0, 10) : '',
      brokerId: o.brokerId || NO_BROKER,
      tonnes: String(o.tonnageKg / 1000),
      ratePerKg: String(o.ratePerKg),
      dueDays: o.dueDays != null ? String(o.dueDays) : '',
      reminderDate: o.reminderDate ? o.reminderDate.slice(0, 10) : '',
    });
    setOpen(true);
  }

  const saveMutation = useMutation({
    mutationFn: (v: SaleForm) => {
      const url = editing ? `/sale-orders/${editing.id}` : '/sale-orders';
      const method = editing ? 'PUT' : 'POST';
      const selectedBuyer = parties?.find((p) => p.id === v.buyerId);
      const selectedAddr = selectedBuyer?.addresses?.find((a) => a.id === v.buyerAddressId);

      return api<SaleOrder>(url, {
        method,
        body: {
          saleDate: v.saleDate,
          product: v.product,
          buyerId: v.buyerId,
          brokerId: v.brokerId === NO_BROKER ? null : v.brokerId,
          tonnageKg: Math.round(Number(v.tonnes) * 1000),
          ratePerKg: Number(v.ratePerKg),
          dueDays: v.dueDays ? Number(v.dueDays) : null,
          reminderDate: v.reminderDate ? v.reminderDate : null,
          poNumber: v.poNumber ? v.poNumber.trim() : null,
          poDate: v.poDate ? v.poDate : null,
          buyerAddressId: v.buyerAddressId || null,
          buyerAddress: selectedAddr?.address || selectedBuyer?.address || null,
          buyerCity: selectedAddr?.city || selectedBuyer?.city || null,
          buyerState: selectedAddr?.state || selectedBuyer?.state || null,
          buyerPincode: selectedAddr?.pincode || selectedBuyer?.pincode || null,
          buyerGstin: selectedAddr?.gstin || selectedBuyer?.gstin || null,
          marginOverride: override,
          gstExempt,
          priceType,
        },
      });
    },
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ['sale-orders'] });
      if (data?.allocationSummary?.warning) {
        toast.warning(data.allocationSummary.warning, { duration: 10000 });
      } else {
        toast.success(editing ? 'Sale order updated' : 'Sale order created');
      }
      setOpen(false);
      form.reset();
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/sale-orders/${id}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sale-orders'] }); toast.success('Sale order deleted'); },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  // --- Reach/Match Delivery dialog ---
  // (Moved to Pappu Sales page)

  // --- Dispatch dialog ---
  // (Moved to Pappu Sales page)

  // --- Raise Invoice ---
  // (Moved to Pappu Sales page)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sale Orders"
        description="Take orders to sell products. Dispatch captures the invoice + kata slip."
        icon={ClipboardList}
        actions={
          <>
            <ExportButtons
              filename="Sale_Orders"
              title="Sale Orders"
              subtitle={`${filtered.length} order(s)`}
              columns={exportColumns}
              rows={filtered}
            />
            <Button variant="outline" onClick={() => setBulkOpen(true)}>
              <Table2 className="h-4 w-4 mr-2" /> Bulk Entry
            </Button>
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4 mr-2" /> New Sale Order
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Status</Label>
          <div className="flex gap-1">
            {STATUS_FILTERS.map((s) => (
              <Button key={s} variant={statusFilter === s ? 'default' : 'outline'} size="sm" onClick={() => setStatusFilter(s)} className="h-9">
                {s === 'ALL' ? 'All' : s.charAt(0) + s.slice(1).toLowerCase()}
              </Button>
            ))}
          </div>
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Payment</Label>
          <div className="flex gap-1">
            {PAY_FILTERS.map((f) => (
              <Button key={f.value} variant={payFilter === f.value ? 'default' : 'outline'} size="sm" onClick={() => setPayFilter(f.value)} className="h-9">
                {f.label}
              </Button>
            ))}
          </div>
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Commodity</Label>
          <Select value={productFilter} onValueChange={(v: any) => setProductFilter(v)}>
            <SelectTrigger className="w-36 bg-card h-9"><SelectValue placeholder="All" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All commodities</SelectItem>
              {PRODUCTS.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Party (Buyer)</Label>
          <Combobox
            options={[{ value: 'ALL', label: 'All parties' }, ...(parties ?? []).filter((p) => p.type !== 'SUPPLIER' && p.type !== 'HAMALI_TEAM' && (productFilter === 'ALL' || p.commodities?.includes(PRODUCT_TO_COMMODITY[productFilter]))).map((p) => ({ value: p.id, label: p.name }))]}
            value={partyFilter}
            onChange={setPartyFilter}
            placeholder="All parties"
            searchPlaceholder="Search party…"
            ariaLabel="Filter by party"
            className="w-48"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Broker</Label>
          <Combobox
            options={[{ value: 'ALL', label: 'All brokers' }, { value: NO_BROKER, label: 'No broker' }, ...(brokers ?? []).map((b) => ({ value: b.id, label: b.name }))]}
            value={brokerFilter}
            onChange={setBrokerFilter}
            placeholder="All brokers"
            searchPlaceholder="Search broker…"
            ariaLabel="Filter by broker"
            className="w-40"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="from-date" className="text-xs text-muted-foreground">From</Label>
          <Input id="from-date" type="date" value={fromDate} max={toDate || undefined} onChange={(e) => setFromDate(e.target.value)} className="w-36 h-9" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="to-date" className="text-xs text-muted-foreground">To</Label>
          <Input id="to-date" type="date" value={toDate} min={fromDate || undefined} onChange={(e) => setToDate(e.target.value)} className="w-36 h-9" />
        </div>
        {(statusFilter !== 'ALL' || payFilter !== 'ALL' || productFilter !== 'ALL' || partyFilter !== 'ALL' || brokerFilter !== 'ALL' || fromDate || toDate) && (
          <button
            type="button"
            onClick={() => { setStatusFilter('ALL'); setPayFilter('ALL'); setProductFilter('ALL'); setPartyFilter('ALL'); setBrokerFilter('ALL'); setFromDate(''); setToDate(''); }}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline pb-2.5"
          >
            Clear
          </button>
        )}
      </div>

      <div className="rounded-lg border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Commodity</TableHead>
              <TableHead>Party</TableHead>
              <TableHead>Broker</TableHead>
              <TableHead>Destination</TableHead>
              <TableHead className="text-right">Ordered</TableHead>
              <TableHead className="text-right">Dispatched</TableHead>
              <TableHead className="text-right">Remaining</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && <TableRow><TableCell colSpan={11} className="text-center text-muted-foreground">Loading…</TableCell></TableRow>}
            {!isLoading && filtered.length === 0 && (
              <TableRow><TableCell colSpan={11} className="text-center text-muted-foreground py-8">No sale orders matching filters.</TableCell></TableRow>
            )}
            {visible.map((o) => (
              <TableRow key={o.id}>
                <TableCell>{shortDate(o.saleDate)}</TableCell>
                <TableCell><Badge variant="outline" className="font-medium">{PRODUCTS.find((p) => p.value === o.product)?.label ?? o.product}</Badge></TableCell>
                <TableCell className="font-medium">
                  <div>{o.buyer?.name ?? '-'}</div>
                  {o.poNumber && (
                    <div className="text-xs text-muted-foreground font-sans mt-0.5">
                      PO: <span className="font-semibold text-foreground">{o.poNumber}</span>
                      {o.poDate && <span className="text-[11px] text-muted-foreground ml-1">({shortDate(o.poDate)})</span>}
                    </div>
                  )}
                  {(o.buyerCity || o.buyerAddress) && (
                    <div className="text-[11px] text-muted-foreground truncate max-w-[190px] mt-0.5" title={o.buyerAddress ?? ''}>
                      📍 {o.buyerCity || o.buyerAddress}
                    </div>
                  )}
                </TableCell>
                <TableCell>{o.broker?.name ?? '-'}</TableCell>
                <TableCell>
                  {o.destination ?? '-'}
                </TableCell>
                <TableCell className="text-right font-semibold">{toTonnes(o.tonnageKg).toFixed(2)} t</TableCell>
                <TableCell className="text-right">{toTonnes(o.dispatchedKg ?? 0).toFixed(2)} t</TableCell>
                <TableCell className="text-right font-semibold">
                  {(o.remainingKg ?? o.tonnageKg) > 0
                    ? <span className="text-amber-600">{toTonnes(o.remainingKg ?? o.tonnageKg).toFixed(2)} t</span>
                    : <span className="text-emerald-600">0.00 t</span>}
                </TableCell>
                <TableCell className="text-right">{rupees(o.ratePerKg)}/kg</TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {(() => {
                      const ds = saleDisplayStatus(o, settled);
                      return <Badge variant={SALE_STATUS_VARIANT[ds]}>{saleStatusLabel(ds)}</Badge>;
                    })()}
                    {(o.shortKg ?? 0) > 0 && (
                      <Badge variant="warning" title={o.closeReason ?? undefined}>
                        Short {toTonnes(o.shortKg!).toFixed(2)}t
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="icon" onClick={() => openEdit(o)} title="Edit Order">
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      onClick={() => { if (confirm('Delete this sale order?')) deleteMutation.mutate(o.id); }}
                      title={o.status !== 'PENDING' ? 'Cannot delete an order with dispatches' : 'Delete Order'}
                      disabled={o.status !== 'PENDING'}
                    >
                      <Trash2 className={`h-4 w-4 ${o.status === 'PENDING' ? 'text-destructive' : 'text-muted-foreground'}`} />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <PaginationBar page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalPages={totalPages} total={total} />

      {/* Create / Edit order dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editing ? 'Edit Sale Order' : 'New Sale Order'}</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit((v) => saveMutation.mutate(v))} className="space-y-4">
              <FormField control={form.control} name="saleDate" render={({ field }) => (
                <FormItem><FormLabel>Date <span className="text-destructive">*</span></FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="product" render={({ field }) => (
                <FormItem>
                  <FormLabel>Commodity <span className="text-destructive">*</span></FormLabel>
                  <Select
                    onValueChange={(v) => {
                      field.onChange(v);
                      // Re-default the pricing basis to the norm for the commodity;
                      // still overridable below for a delivered husk deal.
                      setPriceType(v === 'PAPPU' ? 'DELIVERY' : 'BASE');
                    }}
                    value={field.value}
                  >
                    <FormControl><SelectTrigger><SelectValue placeholder="Select commodity" /></SelectTrigger></FormControl>
                    <SelectContent>{PRODUCTS.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}</SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="buyerId" render={({ field }) => (
                <FormItem>
                  <FormLabel>Party (buyer) <span className="text-destructive">*</span></FormLabel>
                  <FormControl>
                    <Combobox
                      options={(parties ?? []).filter((p) => p.type !== 'SUPPLIER' && p.type !== 'HAMALI_TEAM' && p.commodities?.includes(PRODUCT_TO_COMMODITY[watchedProduct])).map((p) => ({ value: p.id, label: p.name }))}
                      value={field.value}
                      onChange={(val) => {
                        field.onChange(val);
                        const b = parties?.find((p) => p.id === val);
                        if (b?.addresses && b.addresses.length > 0) {
                          const def = b.addresses.find((a) => a.isDefault) || b.addresses[0];
                          form.setValue('buyerAddressId', def.id ?? '');
                        } else {
                          form.setValue('buyerAddressId', '');
                        }
                      }}
                      placeholder="Select buyer"
                      searchPlaceholder="Search buyer…"
                      className="w-full"
                    />
                  </FormControl>
                  {buyerId && (
                    <p className="text-xs text-muted-foreground">
                      Destination: <span className="font-medium">{buyerDestination ?? 'none set on party'}</span>
                      {priceType === 'DELIVERY'
                        ? ' · freight auto-applied from Settings'
                        : ' · base price, no freight applied'}
                    </p>
                  )}
                  <FormMessage />
                </FormItem>
              )} />
              {buyerId && (() => {
                const currentBuyer = parties?.find((p) => p.id === buyerId);
                const buyerAddrs = currentBuyer?.addresses ?? [];
                if (buyerAddrs.length === 0) return null;
                return (
                  <FormField
                    control={form.control}
                    name="buyerAddressId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Delivery / Billing Address</FormLabel>
                        <Select
                          value={field.value || (buyerAddrs.find((a) => a.isDefault)?.id ?? buyerAddrs[0]?.id ?? '')}
                          onValueChange={field.onChange}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Select delivery address" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {buyerAddrs.map((a) => (
                              <SelectItem key={a.id} value={a.id!}>
                                <span className="font-medium">{a.label}</span>
                                {a.isDefault && <span className="text-muted-foreground ml-1">(Default)</span>}
                                <span className="text-muted-foreground text-xs ml-2">
                                  - {[a.city, a.state, a.pincode].filter(Boolean).join(', ')}
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {field.value && (() => {
                          const a = buyerAddrs.find((addr) => addr.id === field.value);
                          if (!a) return null;
                          return (
                            <div className="text-xs text-muted-foreground bg-muted/40 p-2.5 rounded border mt-1 leading-relaxed">
                              <div className="font-medium text-foreground">{a.label}: {a.address}</div>
                              <div>{[a.city, a.state, a.pincode].filter(Boolean).join(', ')}{a.gstin ? ` · GSTIN: ${a.gstin}` : ''}</div>
                            </div>
                          );
                        })()}
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                );
              })()}
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="poNumber" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Buyer PO Number (optional)</FormLabel>
                    <FormControl><Input placeholder="e.g. PO-2026-981" {...field} /></FormControl>
                    <p className="text-[11px] text-muted-foreground">Printed as Buyer's Order No. on the tax invoice.</p>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="poDate" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Buyer PO Date (optional)</FormLabel>
                    <FormControl><Input type="date" {...field} /></FormControl>
                    <p className="text-[11px] text-muted-foreground">Order date printed next to PO number on the invoice.</p>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <FormField control={form.control} name="brokerId" render={({ field }) => (
                <FormItem>
                  <FormLabel>Broker (optional)</FormLabel>
                  <FormControl>
                    <Combobox
                      options={[{ value: NO_BROKER, label: 'No broker' }, ...(brokers ?? []).map((b) => ({ value: b.id, label: b.name }))]}
                      value={field.value ?? NO_BROKER}
                      onChange={field.onChange}
                      placeholder="No broker"
                      searchPlaceholder="Search broker…"
                      className="w-full"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="ratePerKg" render={({ field }) => (
                  <FormItem><FormLabel>Price per kg (₹) <span className="text-destructive">*</span></FormLabel><FormControl><Input type="number" step="0.01" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="tonnes" render={({ field }) => (
                  <FormItem><FormLabel>Tonnage (tonnes) <span className="text-destructive">*</span></FormLabel><FormControl><Input type="number" step="0.001" placeholder="e.g. 25" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
              </div>

              <FormField control={form.control} name="dueDays" render={({ field }) => (
                <FormItem>
                  <FormLabel>Due days (credit period)</FormLabel>
                  <FormControl><Input type="number" min="0" step="1" placeholder="e.g. 30" {...field} /></FormControl>
                  <p className="text-[11px] text-muted-foreground">Counted from the delivered date (when the order is marked Delivered).</p>
                  <FormMessage />
                </FormItem>
              )} />

              <FormField control={form.control} name="reminderDate" render={({ field }) => (
                <FormItem>
                  <FormLabel>Reminder - dispatch date (optional)</FormLabel>
                  <FormControl><Input type="date" {...field} /></FormControl>
                  <p className="text-[11px] text-muted-foreground">For advance orders. You'll be reminded to dispatch from 3 days before this date, every time you log in.</p>
                  <FormMessage />
                </FormItem>
              )} />

              <div className="rounded-lg border bg-muted/40 p-3 text-sm space-y-1.5">
                <div className="flex justify-between"><span className="text-muted-foreground">Base ({toTonnes(weightKg).toFixed(2)} t × {rupees(rate)})</span><span className="font-medium">{base > 0 ? rupees(base) : '-'}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">GST (5% IGST){gstExempt && <span className="ml-1 text-amber-600">- exempt</span>}</span><span className="font-medium">{gstExempt ? '-' : (gst > 0 ? rupees(gst) : '-')}</span></div>
                <div className="flex justify-between border-t pt-1.5"><span className="text-muted-foreground font-semibold">Value{gstExempt ? '' : ' (incl. GST)'}</span><span className="font-bold text-emerald-600">{value > 0 ? rupees(value) : '-'}</span></div>
              </div>

              <div className="space-y-1.5">
                <FormLabel>Price basis</FormLabel>
                <Select
                  value={priceType}
                  onValueChange={(v: 'BASE' | 'DELIVERY') => setPriceType(v)}
                  disabled={!!editing && (editing.dispatchedKg ?? 0) > 0}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="BASE">Base price - buyer lifts ex-works, they pay the lorry</SelectItem>
                    <SelectItem value="DELIVERY">Delivery price - rate includes freight, we pay the lorry</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  {priceType === 'DELIVERY'
                    ? "Freight comes off the buyer's destination rate in Settings and is netted out of this commodity's income."
                    : 'No freight is booked against this order.'}
                  {!!editing && (editing.dispatchedKg ?? 0) > 0 && ' Locked - this order has already dispatched.'}
                </p>
              </div>

              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input type="checkbox" checked={gstExempt} onChange={(e) => setGstExempt(e.target.checked)} />
                Without GST (bill this order to the party without GST)
              </label>

              {watchedProduct === 'PAPPU' && (
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
                  Admin override (sell below the 3% pappu margin)
                </label>
              )}

              <DialogFooter>
                <Button type="submit" disabled={saveMutation.isPending}>{saveMutation.isPending ? 'Saving…' : (editing ? 'Save Changes' : 'Create Sale Order')}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <BulkImportDialog
        type="sale"
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        onSuccess={() => qc.invalidateQueries({ queryKey: ['sale-orders'] })}
      />
    </div>
  );
}
