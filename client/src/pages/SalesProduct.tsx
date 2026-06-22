import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Truck, CheckCircle2, PackageCheck, Upload, Loader2, FileText, Printer } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { SaleOrder, SaleStatus, SaleProduct, Party, Broker } from '@/lib/types';
import { rupees, shortDate, toTonnes } from '@/lib/format';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
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

const statusVariant: Record<SaleStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  PENDING: 'secondary',
  DISPATCHED: 'default',
  REACHED: 'outline',
  DELIVERED: 'destructive',
};

const STATUS_FILTERS: ('ALL' | SaleStatus)[] = ['ALL', 'PENDING', 'DISPATCHED', 'REACHED', 'DELIVERED'];
const NO_BROKER = '__none__';

/** Due date = deliveredDate + dueDays. Null until both are known. */
function dueDateIso(o: SaleOrder): string | null {
  if (!o.deliveredDate || o.dueDays == null) return null;
  const d = new Date(o.deliveredDate);
  d.setDate(d.getDate() + o.dueDays);
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

export default function SalesProduct({ product }: { product: SaleProduct }) {
  const meta = PRODUCT_META[product];
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [statusFilter, setStatusFilter] = useState<'ALL' | SaleStatus>('ALL');
  const [brokerFilter, setBrokerFilter] = useState<string>('ALL');
  const [partyFilter, setPartyFilter] = useState<string>('ALL');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

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
  const [extractingKata, setExtractingKata] = useState(false);

  function openDispatch(o: SaleOrder) {
    setDispatchOrder(o);
    setKataFile(null);
    setVehicleNumber('');
    setDispatchTonnes(String(o.tonnageKg / 1000));
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

  // ── Mark Reached dialog ────────────────────────────────────────────────────
  const [reachOrder, setReachOrder] = useState<SaleOrder | null>(null);
  const [buyerKataFile, setBuyerKataFile] = useState<File | null>(null);
  const [buyerKataTonnes, setBuyerKataTonnes] = useState('');

  function openReach(o: SaleOrder) {
    setReachOrder(o);
    setBuyerKataFile(null);
    setBuyerKataTonnes(String(o.tonnageKg / 1000));
  }

  const reachMutation = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      if (buyerKataFile) fd.append('kata', buyerKataFile);
      const val = Number(buyerKataTonnes);
      if (val > 0) fd.append('buyerKataKg', String(Math.round(val * 1000)));
      return api(`/sale-orders/${reachOrder!.id}/advance`, { method: 'POST', body: fd, multipart: true });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sale-orders'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success('Marked reached & delivery matched');
      setReachOrder(null);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const reachTonnes = Number(buyerKataTonnes) || 0;
  const reachKg = Math.round(reachTonnes * 1000);
  const reachShortageKg = reachOrder ? Math.max(0, reachOrder.tonnageKg - reachKg) : 0;
  const reachCreditAmount = reachOrder ? reachShortageKg * Number(reachOrder.ratePerKg) * (1 + GST_RATE) : 0;

  // ── Mark Delivered dialog ──────────────────────────────────────────────────
  const [deliverOrder, setDeliverOrder] = useState<SaleOrder | null>(null);
  const [deliverKataFile, setDeliverKataFile] = useState<File | null>(null);

  function openDeliver(o: SaleOrder) {
    setDeliverOrder(o);
    setDeliverKataFile(null);
  }

  const deliverMutation = useMutation({
    mutationFn: () => {
      // Only send multipart when a kata slip is attached — an empty FormData
      // produces a malformed multipart body that multer rejects on the server.
      if (deliverKataFile) {
        const fd = new FormData();
        fd.append('kata', deliverKataFile);
        return api(`/sale-orders/${deliverOrder!.id}/deliver`, { method: 'POST', body: fd, multipart: true });
      }
      return api(`/sale-orders/${deliverOrder!.id}/deliver`, { method: 'POST' });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sale-orders'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success('Order marked as Delivered');
      setDeliverOrder(null);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  // ── Raise Invoice ──────────────────────────────────────────────────────────
  const [invoiceOrder, setInvoiceOrder] = useState<SaleOrder | null>(null);

  const raiseInvoiceMutation = useMutation({
    mutationFn: () => api<SaleOrder>(`/sale-orders/${invoiceOrder!.id}/invoice`, { method: 'POST' }),
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ['sale-orders'] });
      toast.success(`Invoice ${saved.invoiceNumber} generated`);
      setInvoiceOrder(null);
      navigate(`/sale-orders/${saved.id}/invoice`);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const invoiceBase = invoiceOrder ? invoiceOrder.tonnageKg * Number(invoiceOrder.ratePerKg) : 0;
  const invoiceGst = Math.round(invoiceBase * GST_RATE * 100) / 100;
  const invoiceCn = Number(invoiceOrder?.creditNoteAmount || 0);
  const invoiceNet = invoiceBase + invoiceGst - invoiceCn;

  // ── Simple view for non-Pappu products ────────────────────────────────────
  if (product !== 'PAPPU') {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">{meta.title}</h1>
          <p className="text-muted-foreground">{meta.noun} sales from sale orders · create &amp; dispatch on the Sale Orders page.</p>
        </div>
        <div className="flex flex-wrap items-end gap-3 mb-2">
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
            <Label className="text-xs text-muted-foreground">Party (Buyer)</Label>
            <Select value={partyFilter} onValueChange={setPartyFilter}>
              <SelectTrigger className="w-48 bg-card h-9"><SelectValue placeholder="All" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All parties</SelectItem>
                {parties?.filter(p => p.type !== 'SUPPLIER').map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="from-date" className="text-xs text-muted-foreground">From</Label>
            <Input id="from-date" type="date" value={fromDate} max={toDate || undefined} onChange={(e) => setFromDate(e.target.value)} className="w-36 h-9" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="to-date" className="text-xs text-muted-foreground">To</Label>
            <Input id="to-date" type="date" value={toDate} min={fromDate || undefined} onChange={(e) => setToDate(e.target.value)} className="w-36 h-9" />
          </div>
        </div>
        <div className="rounded-lg border bg-card overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Invoice No</TableHead>
                <TableHead>Party</TableHead>
                <TableHead>Broker</TableHead>
                <TableHead>Destination</TableHead>
                <TableHead className="text-right">Total Weight</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead className="text-right">GST (5%)</TableHead>
                <TableHead className="text-right">Freight (ours)</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && <TableRow><TableCell colSpan={11} className="text-center text-muted-foreground">Loading…</TableCell></TableRow>}
              {!isLoading && visible.length === 0 && (
                <TableRow><TableCell colSpan={11} className="text-center text-muted-foreground py-8">No {meta.noun.toLowerCase()} sales matching filters.</TableCell></TableRow>
              )}
              {visible.map((o) => {
                const price = Number(o.ratePerKg);
                const gstAmt = Number(o.gstAmount);
                const val = o.tonnageKg * price + gstAmt;
                return (
                  <TableRow key={o.id}>
                    <TableCell>{shortDate(o.saleDate)}</TableCell>
                    <TableCell className="font-mono text-sm">{o.invoiceNumber ?? '—'}</TableCell>
                    <TableCell className="font-medium">{o.buyer?.name ?? '—'}</TableCell>
                    <TableCell>{o.broker?.name ?? '—'}</TableCell>
                    <TableCell>{o.destination ?? '—'}</TableCell>
                    <TableCell className="text-right font-semibold">{toTonnes(o.tonnageKg).toFixed(2)} t</TableCell>
                    <TableCell className="text-right">{rupees(price)}/kg</TableCell>
                    <TableCell className="text-right text-muted-foreground">{rupees(gstAmt)}</TableCell>
                    <TableCell className="text-right text-amber-600">{Number(o.freightCharge) > 0 ? rupees(o.freightCharge) : '—'}</TableCell>
                    <TableCell className="text-right font-semibold text-emerald-600">{rupees(val)}</TableCell>
                    <TableCell><Badge variant={statusVariant[o.status]}>{o.status.charAt(0) + o.status.slice(1).toLowerCase()}</Badge></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>
    );
  }

  // ── Full Pappu workflow view ────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Pappu Sales</h1>
        <p className="text-muted-foreground">Manage the full pappu dispatch lifecycle — dispatch, match delivery &amp; mark delivered.</p>
      </div>

      {/* Filters */}
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
          <Label className="text-xs text-muted-foreground">Party (Buyer)</Label>
          <Select value={partyFilter} onValueChange={setPartyFilter}>
            <SelectTrigger className="w-48 bg-card h-9"><SelectValue placeholder="All" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All parties</SelectItem>
              {parties?.filter(p => p.type !== 'SUPPLIER').map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Broker</Label>
          <Select value={brokerFilter} onValueChange={setBrokerFilter}>
            <SelectTrigger className="w-40 bg-card h-9"><SelectValue placeholder="All" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All brokers</SelectItem>
              <SelectItem value={NO_BROKER}>No broker</SelectItem>
              {brokers?.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="p-from" className="text-xs text-muted-foreground">From</Label>
          <Input id="p-from" type="date" value={fromDate} max={toDate || undefined} onChange={(e) => setFromDate(e.target.value)} className="w-36 h-9" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="p-to" className="text-xs text-muted-foreground">To</Label>
          <Input id="p-to" type="date" value={toDate} min={fromDate || undefined} onChange={(e) => setToDate(e.target.value)} className="w-36 h-9" />
        </div>
        {(statusFilter !== 'ALL' || partyFilter !== 'ALL' || brokerFilter !== 'ALL' || fromDate || toDate) && (
          <button type="button" onClick={() => { setStatusFilter('ALL'); setPartyFilter('ALL'); setBrokerFilter('ALL'); setFromDate(''); setToDate(''); }}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline pb-2.5">Clear</button>
        )}
      </div>

      {/* Table */}
      <div className="rounded-lg border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Invoice No</TableHead>
              <TableHead>Party</TableHead>
              <TableHead>Broker</TableHead>
              <TableHead>Destination</TableHead>
              <TableHead className="text-right">Tonnage</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="text-right">Shortage</TableHead>
              <TableHead className="text-right">TDS (0.1%)</TableHead>
              <TableHead className="text-right">Net Due</TableHead>
              <TableHead>Due Date</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-44 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && <TableRow><TableCell colSpan={13} className="text-center text-muted-foreground">Loading…</TableCell></TableRow>}
            {!isLoading && visible.length === 0 && (
              <TableRow><TableCell colSpan={13} className="text-center text-muted-foreground py-8">No pappu sales matching filters.</TableCell></TableRow>
            )}
            {visible.map((o) => {
              const dueIso = dueDateIso(o);
              const overdue = isOverdue(dueIso);
              const soon = isDueSoon(dueIso);
              const netDue = (o.tonnageKg * Number(o.ratePerKg) * (1 + GST_RATE)) - Number(o.creditNoteAmount || 0);
              const tds = o.tonnageKg * Number(o.ratePerKg) * 0.001; // 0.1% of base sale value
              const shortageAmount = Number(o.creditNoteAmount || 0); // shortage value (incl. GST)
              return (
                <TableRow key={o.id}>
                  <TableCell>{shortDate(o.saleDate)}</TableCell>
                  <TableCell className="font-mono text-sm">
                    {o.invoiceNumber ?? (o.status === 'PENDING' ? '—' : <span className="text-[10px] text-amber-600 font-sans">not raised</span>)}
                    {o.invoiceFileUrl && <a href={o.invoiceFileUrl} target="_blank" rel="noreferrer" className="block text-[10px] text-blue-500 hover:underline font-sans">Invoice</a>}
                    {o.kataFileUrl && <a href={o.kataFileUrl} target="_blank" rel="noreferrer" className="block text-[10px] text-blue-500 hover:underline font-sans">Dispatch Kata</a>}
                    {o.buyerKataFileUrl && <a href={o.buyerKataFileUrl} target="_blank" rel="noreferrer" className="block text-[10px] text-blue-500 hover:underline font-sans">Buyer Kata</a>}
                  </TableCell>
                  <TableCell className="font-medium">{o.buyer?.name ?? '—'}</TableCell>
                  <TableCell>{o.broker?.name ?? '—'}</TableCell>
                  <TableCell>{o.destination ?? '—'}</TableCell>
                  <TableCell className="text-right font-semibold">{toTonnes(o.tonnageKg).toFixed(2)} t</TableCell>
                  <TableCell className="text-right">{rupees(o.ratePerKg)}/kg</TableCell>
                  <TableCell className="text-right">
                    {shortageAmount > 0
                      ? <span className="text-destructive font-medium">−{rupees(shortageAmount)}</span>
                      : <span className="text-muted-foreground">—</span>}
                    {o.shortageKg ? <div className="text-[10px] text-muted-foreground">{toTonnes(o.shortageKg).toFixed(3)} t</div> : null}
                  </TableCell>
                  <TableCell className="text-right text-rose-600 dark:text-rose-400">{rupees(tds)}</TableCell>
                  <TableCell className="text-right font-bold text-emerald-600">{rupees(netDue)}</TableCell>
                  <TableCell>
                    {dueIso ? (
                      <span className={`text-xs font-medium ${overdue ? 'text-destructive' : soon ? 'text-amber-600' : 'text-muted-foreground'}`}>
                        {overdue ? 'OVERDUE ' : ''}{shortDate(dueIso)}{o.dueDays != null ? ` (${o.dueDays}d)` : ''}
                      </span>
                    ) : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant[o.status]}>{o.status.charAt(0) + o.status.slice(1).toLowerCase()}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1 flex-wrap">
                      {o.status === 'PENDING' && (
                        <Button size="sm" variant="outline" className="h-8" onClick={() => openDispatch(o)}>
                          <Truck className="h-3.5 w-3.5" /> Dispatch
                        </Button>
                      )}
                      {(o.status === 'DISPATCHED' || o.status === 'REACHED' || o.status === 'DELIVERED') && (
                        o.invoiceNumber ? (
                          <Button size="sm" variant="ghost" className="h-8" onClick={() => navigate(`/sale-orders/${o.id}/invoice`)}>
                            <Printer className="h-3.5 w-3.5" /> Invoice
                          </Button>
                        ) : (
                          <Button size="sm" variant="outline" className="h-8" onClick={() => setInvoiceOrder(o)}>
                            <FileText className="h-3.5 w-3.5" /> Raise Invoice
                          </Button>
                        )
                      )}
                      {o.status === 'DISPATCHED' && (
                        <Button size="sm" variant="outline" className="h-8" onClick={() => openReach(o)}>
                          <CheckCircle2 className="h-3.5 w-3.5" /> Mark Reached
                        </Button>
                      )}
                      {o.status === 'REACHED' && (
                        <Button size="sm" variant="default" className="h-8 bg-emerald-600 hover:bg-emerald-700" onClick={() => openDeliver(o)}>
                          <PackageCheck className="h-3.5 w-3.5" /> Mark Delivered
                        </Button>
                      )}
                      {o.status === 'DELIVERED' && (
                        <span className="text-xs text-emerald-600 font-semibold pr-1">✓ Delivered</span>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
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
            <p className="text-sm text-muted-foreground">Drop the kata slip. We'll read the vehicle no and weight — edit if needed, then dispatch.</p>
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
            </div>
            <DialogFooter>
              <Button onClick={() => dispatchMutation.mutate()} disabled={(Number(dispatchTonnes) || 0) <= 0 || dispatchMutation.isPending}>
                {dispatchMutation.isPending ? 'Dispatching…' : 'Confirm Dispatch'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {/* Raise Invoice dialog */}
      <Dialog open={!!invoiceOrder} onOpenChange={(v) => !v && setInvoiceOrder(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Raise Invoice — {invoiceOrder?.buyer?.name}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">A tax invoice will be generated with the next auto number.</p>
            <div className="rounded-lg border bg-muted/40 p-3 text-sm space-y-1.5">
              <div className="flex justify-between"><span className="text-muted-foreground">Base ({invoiceOrder ? toTonnes(invoiceOrder.tonnageKg).toFixed(2) : 0} t × {rupees(invoiceOrder?.ratePerKg ?? 0)})</span><span className="font-medium">{rupees(invoiceBase)}</span></div>
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

      {/* Mark Reached dialog */}
      <Dialog open={!!reachOrder} onOpenChange={(v) => !v && setReachOrder(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Match Delivery — {reachOrder?.buyer?.name}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">Lorry has reached. Enter buyer's kata weight to auto-calculate shortage &amp; credit note.</p>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs">Dispatched Weight</Label>
                <div className="text-sm font-semibold">{reachOrder ? toTonnes(reachOrder.tonnageKg).toFixed(2) : 0} tonnes</div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Invoice Rate</Label>
                <div className="text-sm font-medium">{reachOrder ? rupees(reachOrder.ratePerKg) : 0}/kg + 5% GST</div>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Buyer's Kata Weight (tonnes)</Label>
              <Input type="number" step="0.001" value={buyerKataTonnes} onChange={(e) => setBuyerKataTonnes(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Buyer's Kata Slip (optional)</Label>
              <label className="flex items-center gap-2 cursor-pointer rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground hover:bg-accent">
                <Upload className="h-3.5 w-3.5" /> {buyerKataFile ? buyerKataFile.name.slice(0, 25) : 'Drop kata slip'}
                <input type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) setBuyerKataFile(f); }} />
              </label>
            </div>
            {reachShortageKg > 0 && (
              <div className="rounded-lg border bg-rose-50/50 dark:bg-rose-950/20 p-3 text-sm space-y-1.5">
                <div className="font-semibold text-rose-700 mb-2">Shortage Detected</div>
                <div className="flex justify-between text-rose-600"><span>Weight difference:</span><span className="font-medium">−{reachShortageKg} kg</span></div>
                <div className="flex justify-between text-rose-600"><span>Value loss (base):</span><span className="font-medium">−{rupees(reachShortageKg * Number(reachOrder?.ratePerKg || 0))}</span></div>
                <div className="flex justify-between border-t border-rose-200 pt-1.5 font-semibold text-rose-700"><span>Auto credit note (incl. GST)</span><span>{rupees(reachCreditAmount)}</span></div>
              </div>
            )}
            {reachShortageKg === 0 && reachTonnes > 0 && (
              <div className="rounded-lg border bg-emerald-50/50 p-3 text-sm text-emerald-700 font-medium text-center">Weights match. No credit note needed.</div>
            )}
            {reachShortageKg < 0 && (
              <div className="rounded-lg border bg-rose-50/50 p-3 text-sm text-rose-700 font-medium text-center">Buyer weight cannot exceed dispatch weight.</div>
            )}
            <DialogFooter>
              <Button onClick={() => reachMutation.mutate()} disabled={reachMutation.isPending || reachTonnes <= 0 || reachShortageKg < 0}>
                {reachMutation.isPending ? 'Saving…' : reachShortageKg > 0 ? 'Match Delivery & Raise CN' : 'Match Delivery'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {/* Mark Delivered dialog */}
      <Dialog open={!!deliverOrder} onOpenChange={(v) => !v && setDeliverOrder(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Mark as Delivered — {deliverOrder?.buyer?.name}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Confirm that the buyer has received the goods. The delivered date will be set to today and the payment due date will be calculated from it.
            </p>
            {deliverOrder?.dueDays && (
              <div className="rounded-lg border bg-muted/40 p-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Payment due in</span>
                  <span className="font-semibold">{deliverOrder.dueDays} days from today</span>
                </div>
                <div className="flex justify-between mt-1">
                  <span className="text-muted-foreground">Due date</span>
                  <span className="font-bold text-primary">
                    {shortDate(new Date(Date.now() + deliverOrder.dueDays * 86400000).toISOString())}
                  </span>
                </div>
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs">Buyer's Kata Slip (optional)</Label>
              <label className="flex items-center gap-2 cursor-pointer rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground hover:bg-accent">
                <Upload className="h-3.5 w-3.5" /> {deliverKataFile ? deliverKataFile.name.slice(0, 28) : 'Attach buyer kata slip'}
                <input type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) setDeliverKataFile(f); }} />
              </label>
            </div>
            <DialogFooter>
              <Button onClick={() => deliverMutation.mutate()} disabled={deliverMutation.isPending} className="bg-emerald-600 hover:bg-emerald-700">
                <PackageCheck className="h-4 w-4" /> {deliverMutation.isPending ? 'Saving…' : 'Confirm Delivered'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
