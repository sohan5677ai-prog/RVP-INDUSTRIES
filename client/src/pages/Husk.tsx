import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Layers, Plus, Trash2, ArrowRight, Package, TrendingDown, Warehouse } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { HuskTransfer, SaleOrder } from '@/lib/types';
import { shellTransferCost, SHELL_HAMALI_RATE, transferTransportRate } from '@/lib/calc';
import { kg, rupees, shortDate, toTonnes } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Combobox } from '@/components/ui/combobox';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';
import SalesProduct from './SalesProduct';

const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

const HUSK_TRANSFER_COLUMNS: ExportColumn<HuskTransfer>[] = [
  { header: 'Date', value: (t) => shortDate(t.transferDate) },
  { header: 'Route', value: (t) => `${t.fromLocation} → ${t.toLocation}` },
  { header: 'Lorry', value: (t) => t.lorryNumber ?? '' },
  { header: 'Transferred (kg)', value: (t) => t.weightKg, numFmt: '#,##0', align: 'right' },
  { header: 'Deducted / Sold (kg)', value: (t) => t.soldKg ?? 0, numFmt: '#,##0', align: 'right' },
  { header: 'Balance Left (kg)', value: (t) => t.remainingKg ?? t.weightKg, numFmt: '#,##0', align: 'right' },
  { header: 'Hamali', value: (t) => rupees(t.hamaliCharge), excel: (t) => Number(t.hamaliCharge), numFmt: '#,##0.00', align: 'right' },
  { header: 'Transport', value: (t) => rupees(t.transportCharge), excel: (t) => Number(t.transportCharge), numFmt: '#,##0.00', align: 'right' },
  { header: 'Total Cost', value: (t) => rupees(t.totalCost), excel: (t) => Number(t.totalCost), numFmt: '#,##0.00', align: 'right' },
];

export interface HuskTransferSale {
  id: string;
  saleOrderId: string;
  dispatchDate: string;
  invoiceNumber: string | null;
  buyerName: string;
  vehicleNumber: string | null;
  transferLocation: string;
  transferWeightKg: number;
  totalWeightKg: number;
  status: string;
}

const HUSK_DEDUCTION_COLUMNS: ExportColumn<HuskTransferSale>[] = [
  { header: 'Date', value: (s) => shortDate(s.dispatchDate) },
  { header: 'Invoice', value: (s) => s.invoiceNumber ?? 'Uninvoiced' },
  { header: 'Buyer', value: (s) => s.buyerName },
  { header: 'Storage Location', value: (s) => s.transferLocation },
  { header: 'Lorry', value: (s) => s.vehicleNumber ?? '-' },
  { header: 'Deducted (kg)', value: (s) => s.transferWeightKg, numFmt: '#,##0', align: 'right' },
  { header: 'Total Lorry (kg)', value: (s) => s.totalWeightKg, numFmt: '#,##0', align: 'right' },
  { header: 'Status', value: (s) => titleCase(s.status) },
];

// The storage locations husk can be moved to (RVP is the source factory).
const HUSK_STORAGES = ['PGR COLD', 'Murugan', 'KNM Multi'] as const;

/**
 * Husk detail. Sales is the standard dispatch → invoice → deliver flow. Transfers
 * move our own husk from the factory to storage locations, expensing
 * the same ₹333/t hamali + location transport as the shell/dust transfers.
 */
export default function Husk() {
  return (
    <div className="space-y-6">
      <PageHeader
        icon={Layers}
        title="Husk"
        description="Sell husk through the full dispatch lifecycle, or transfer and manage stock across storage locations."
      />
      <Tabs defaultValue="sales" className="gap-4">
        <TabsList>
          <TabsTrigger value="sales">Sales</TabsTrigger>
          <TabsTrigger value="transfers">Transfers</TabsTrigger>
        </TabsList>

        <TabsContent value="sales">
          <SalesProduct product="HUSK" hideHeader />
        </TabsContent>
        <TabsContent value="transfers">
          <TransfersPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Transfers: move our own husk to storage locations and track balances ─────
function TransfersPanel() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data: transfers, isLoading: loadingTransfers } = useQuery({
    queryKey: ['husk-transfers'],
    queryFn: () => api<HuskTransfer[]>('/husk-transfers'),
  });

  const { data: orders, isLoading: loadingOrders } = useQuery({
    queryKey: ['sale-orders', 'HUSK'],
    queryFn: () => api<SaleOrder[]>('/sale-orders?product=HUSK&all=true'),
  });

  // Extract all outward dispatches sold from transfers
  const transferSales: HuskTransferSale[] = useMemo(() => {
    const list: HuskTransferSale[] = [];
    for (const order of orders ?? []) {
      for (const d of order.dispatches ?? []) {
        if (d.fromTransfer) {
          const qty = d.transferWeightKg != null ? Number(d.transferWeightKg) : d.weightKg;
          list.push({
            id: d.id,
            saleOrderId: order.id,
            dispatchDate: d.dispatchDate,
            invoiceNumber: d.invoiceNumber ?? null,
            buyerName: order.buyer?.name ?? 'Unknown Buyer',
            vehicleNumber: d.vehicleNumber ?? null,
            transferLocation: d.transferLocation || 'Storage',
            transferWeightKg: qty,
            totalWeightKg: d.weightKg,
            status: d.status,
          });
        }
      }
    }
    return list.sort((a, b) => new Date(b.dispatchDate).getTime() - new Date(a.dispatchDate).getTime());
  }, [orders]);

  const transferredKg = (transfers ?? []).reduce((sum, t) => sum + t.weightKg, 0);
  const soldKg = transferSales.reduce((sum, s) => sum + s.transferWeightKg, 0);
  const remainingKg = Math.max(0, transferredKg - soldKg);
  const totalCost = (transfers ?? []).reduce((sum, t) => sum + Number(t.totalCost), 0);

  // Group stock balances per storage location
  const locationBalances = useMemo(() => {
    const locMap = new Map<string, { inKg: number; soldKg: number }>();

    for (const s of HUSK_STORAGES) {
      locMap.set(s, { inKg: 0, soldKg: 0 });
    }

    for (const t of transfers ?? []) {
      const loc = t.toLocation?.trim() || 'Unknown';
      const cur = locMap.get(loc) ?? { inKg: 0, soldKg: 0 };
      cur.inKg += t.weightKg;
      locMap.set(loc, cur);
    }

    for (const s of transferSales) {
      let matchedKey = s.transferLocation;
      for (const key of locMap.keys()) {
        if (key.toLowerCase() === s.transferLocation.trim().toLowerCase()) {
          matchedKey = key;
          break;
        }
      }
      const cur = locMap.get(matchedKey) ?? { inKg: 0, soldKg: 0 };
      cur.soldKg += s.transferWeightKg;
      locMap.set(matchedKey, cur);
    }

    return Array.from(locMap.entries()).map(([location, data]) => {
      const balanceKg = Math.max(0, data.inKg - data.soldKg);
      const pctLeft = data.inKg > 0 ? Math.min(100, (balanceKg / data.inKg) * 100) : 0;
      return {
        location,
        inKg: data.inKg,
        soldKg: data.soldKg,
        balanceKg,
        pctLeft,
        isOverdrawn: data.soldKg > data.inKg,
      };
    });
  }, [transfers, transferSales]);

  const [toLocation, setToLocation] = useState<string>(HUSK_STORAGES[0]);
  const [weight, setWeight] = useState('');
  const [lorryNumber, setLorryNumber] = useState('');
  const [transferDate, setTransferDate] = useState(() => new Date().toISOString().slice(0, 10));

  const weightKg = Number(weight) || 0;
  const weightValid = weightKg > 0 && !!toLocation;
  const cost = weightKg > 0 ? shellTransferCost(weightKg, SHELL_HAMALI_RATE, toLocation) : { hamaliCharge: 0, transportCharge: 0, totalCost: 0 };

  function resetForm() {
    setToLocation(HUSK_STORAGES[0]);
    setWeight('');
    setLorryNumber('');
    setTransferDate(new Date().toISOString().slice(0, 10));
  }

  const mutation = useMutation({
    mutationFn: () =>
      api<HuskTransfer>('/husk-transfers', {
        method: 'POST',
        body: { toLocation, weightKg, lorryNumber: lorryNumber || null, transferDate },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['husk-transfers'] });
      qc.invalidateQueries({ queryKey: ['sale-orders', 'HUSK'] });
      toast.success('Husk transfer recorded');
      setOpen(false);
      resetForm();
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/husk-transfers/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['husk-transfers'] });
      qc.invalidateQueries({ queryKey: ['sale-orders', 'HUSK'] });
      toast.success('Husk transfer reversed');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const isLoading = loadingTransfers || loadingOrders;

  return (
    <div className="space-y-6">
      {/* ── Key Metrics Cards ────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 stagger">
        <StatCard
          label="Total husk transferred"
          value={`${toTonnes(transferredKg).toFixed(2)} MT`}
          icon={Package}
          tone="amber"
          hint={`${kg(transferredKg)} moved to storage`}
        />
        <StatCard
          label="Sold from storage"
          value={`${toTonnes(soldKg).toFixed(2)} MT`}
          icon={TrendingDown}
          tone="clay"
          hint={`${kg(soldKg)} deducted via sales`}
        />
        <StatCard
          label="Current stock left"
          value={`${toTonnes(remainingKg).toFixed(2)} MT`}
          icon={Warehouse}
          tone={remainingKg > 0 ? 'forest' : 'taupe'}
          hint={`${kg(remainingKg)} available across storages`}
        />
        <StatCard
          label="Transfer cost"
          value={rupees(totalCost)}
          icon={ArrowRight}
          tone="forest"
          hint="hamali + transport, expensed"
        />
      </div>

      {/* ── Location-wise Storage Balances ─────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Storage Location Balances</h3>
            <p className="text-xs text-muted-foreground">Real-time stock balance after deducting sales made from storage</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {locationBalances.map((loc) => (
            <div key={loc.location} className="glass rounded-xl p-4 space-y-3 border border-border/60">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Warehouse className="h-4 w-4" />
                  </div>
                  <div>
                    <span className="font-semibold text-sm">{loc.location}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {loc.inKg > 0 ? `${loc.pctLeft.toFixed(0)}% available` : 'No transfers'}
                    </span>
                  </div>
                </div>
                <Badge
                  variant={loc.balanceKg > 0 ? 'success' : loc.inKg > 0 ? 'secondary' : 'outline'}
                  className="font-mono text-xs"
                >
                  {toTonnes(loc.balanceKg).toFixed(2)} MT left
                </Badge>
              </div>

              {/* Progress bar */}
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-emerald-600 transition-all duration-500"
                  style={{ width: `${loc.pctLeft}%` }}
                />
              </div>

              <div className="grid grid-cols-2 gap-2 pt-1 border-t border-border/40 text-xs">
                <div>
                  <span className="text-[11px] text-muted-foreground block">Transferred In</span>
                  <span className="font-mono font-medium">{toTonnes(loc.inKg).toFixed(2)} MT</span>
                </div>
                <div className="text-right">
                  <span className="text-[11px] text-muted-foreground block">Sold Out</span>
                  <span className="font-mono font-medium text-amber-700 dark:text-amber-400">
                    {toTonnes(loc.soldKg).toFixed(2)} MT
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Inward Transfers Table ────────────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Inward Transfers (Factory → Storage)</h3>
            <p className="text-xs text-muted-foreground">
              Factory → storage transfers · hamali ₹{SHELL_HAMALI_RATE}/t + per-tonne transport (₹250/t PGR COLD &amp; Murugan, ₹100/t KNM Multi).
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ExportButtons
              filename="Husk_Transfers"
              title="Husk Transfers"
              subtitle={`${transfers?.length ?? 0} transfer(s)`}
              columns={HUSK_TRANSFER_COLUMNS}
              rows={transfers ?? []}
            />
            <Button onClick={() => { resetForm(); setOpen(true); }}>
              <Plus className="h-4 w-4" /> Record Transfer
            </Button>
          </div>
        </div>

        <div className="glass rounded-2xl overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Route</TableHead>
                <TableHead>Lorry</TableHead>
                <TableHead className="text-right">Transferred</TableHead>
                <TableHead className="text-right">Deducted / Sold</TableHead>
                <TableHead className="text-right">Stock Left</TableHead>
                <TableHead className="text-right">Hamali</TableHead>
                <TableHead className="text-right">Transport</TableHead>
                <TableHead className="text-right">Total cost</TableHead>
                <TableHead className="w-16 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={10} className="h-24 text-center text-muted-foreground">Loading…</TableCell></TableRow>
              )}
              {!isLoading && transfers?.length === 0 && (
                <TableRow><TableCell colSpan={10} className="h-28 text-center text-muted-foreground">No husk transfers yet.</TableCell></TableRow>
              )}
              {transfers?.map((t) => {
                const rem = t.remainingKg != null ? t.remainingKg : t.weightKg;
                const sold = t.soldKg ?? 0;
                return (
                  <TableRow key={t.id} className="group">
                    <TableCell className="text-muted-foreground">{shortDate(t.transferDate)}</TableCell>
                    <TableCell className="font-medium">
                      <span className="inline-flex items-center gap-1.5">
                        {t.fromLocation} <ArrowRight className="h-3 w-3 text-muted-foreground" /> {t.toLocation}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{t.lorryNumber ?? '-'}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{kg(t.weightKg)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {sold > 0 ? (
                        <span className="text-amber-700 dark:text-amber-400 font-medium">−{kg(sold)}</span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {rem === 0 ? (
                        <Badge variant="secondary" className="font-mono text-[11px] opacity-80">
                          0 kg (Sold out)
                        </Badge>
                      ) : rem < t.weightKg ? (
                        <Badge variant="warning" className="font-mono text-[11px]">
                          {kg(rem)} left
                        </Badge>
                      ) : (
                        <Badge variant="success" className="font-mono text-[11px]">
                          {kg(rem)} full
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{rupees(t.hamaliCharge)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{rupees(t.transportCharge)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums font-semibold">{rupees(t.totalCost)}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="opacity-60 transition-opacity group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
                        title={sold > 0 ? 'Warning: Stock has already been sold from this location.' : 'Reverse transfer'}
                        onClick={() => {
                          if (confirm(`Reverse this transfer? ${t.weightKg} kg of husk leaves ${t.toLocation}.`)) {
                            deleteMutation.mutate(t.id);
                          }
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* ── Deductions: Sales Dispatches from Storage ──────────────────────── */}
      <div className="space-y-3 pt-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Sales from Transfers (Deductions)</h3>
            <p className="text-xs text-muted-foreground">
              Shipments sold out of storage stock rather than straight from the RVP factory mill.
            </p>
          </div>
          {transferSales.length > 0 && (
            <ExportButtons
              filename="Husk_Sales_From_Storage"
              title="Husk Sales from Storage Deductions"
              subtitle={`${transferSales.length} dispatch(es)`}
              columns={HUSK_DEDUCTION_COLUMNS}
              rows={transferSales}
            />
          )}
        </div>

        <div className="glass rounded-2xl overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Dispatch Date</TableHead>
                <TableHead>Invoice</TableHead>
                <TableHead>Buyer</TableHead>
                <TableHead>Storage Location</TableHead>
                <TableHead>Lorry</TableHead>
                <TableHead className="text-right">Deducted Weight</TableHead>
                <TableHead className="text-right">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={7} className="h-24 text-center text-muted-foreground">Loading…</TableCell></TableRow>
              )}
              {!isLoading && transferSales.length === 0 && (
                <TableRow><TableCell colSpan={7} className="h-24 text-center text-muted-foreground">No sales dispatches from storage yet.</TableCell></TableRow>
              )}
              {transferSales.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="text-muted-foreground">{shortDate(s.dispatchDate)}</TableCell>
                  <TableCell className="font-mono text-xs font-semibold">
                    {s.invoiceNumber ?? <span className="font-sans text-xs text-muted-foreground font-normal">Uninvoiced</span>}
                  </TableCell>
                  <TableCell className="font-medium">{s.buyerName}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="font-medium border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300">
                      {s.transferLocation}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{s.vehicleNumber ?? '-'}</TableCell>
                  <TableCell className="text-right">
                    <span className="font-mono font-semibold tabular-nums text-amber-700 dark:text-amber-400">
                      −{toTonnes(s.transferWeightKg).toFixed(2)} MT
                    </span>
                    {s.transferWeightKg < s.totalWeightKg && (
                      <span className="block text-[10px] text-muted-foreground font-normal">
                        of {toTonnes(s.totalWeightKg).toFixed(2)} MT total lorry
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Badge variant={s.status === 'DELIVERED' ? 'success' : 'soft'}>
                      {titleCase(s.status)}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* ── Record Transfer Dialog ────────────────────────────────────────── */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Record Husk Transfer</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Storage location</Label>
              <Combobox
                options={HUSK_STORAGES.map((s) => ({ value: s, label: s }))}
                value={toLocation}
                onChange={setToLocation}
                placeholder="Select storage…"
                searchPlaceholder="Search storage…"
                ariaLabel="Select storage location"
                className="w-full"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="htweight">Weight to move (kg)</Label>
              <Input id="htweight" type="number" value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="e.g. 5000" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="htlorry">Lorry number</Label>
                <Input id="htlorry" value={lorryNumber} onChange={(e) => setLorryNumber(e.target.value)} placeholder="AP02AB1234" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="htdate">Transfer date</Label>
                <Input id="htdate" type="date" value={transferDate} onChange={(e) => setTransferDate(e.target.value)} />
              </div>
            </div>

            <div className="rounded-lg border bg-muted/40 p-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Hamali (₹{SHELL_HAMALI_RATE}/t - pack, load &amp; unload)</span>
                <span className="font-medium">{rupees(cost.hamaliCharge)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Transport (₹{transferTransportRate(toLocation)}/t → KNM Transport)</span>
                <span className="font-medium">{rupees(cost.transportCharge)}</span>
              </div>
              <div className="flex justify-between border-t pt-2">
                <span className="text-muted-foreground font-semibold">Cost capitalised at {toLocation || 'storage'}</span>
                <span className="font-bold text-primary">{weightValid ? rupees(cost.totalCost) : '-'}</span>
              </div>
            </div>

            <DialogFooter>
              <Button onClick={() => mutation.mutate()} disabled={!weightValid || mutation.isPending}>
                {mutation.isPending ? 'Saving…' : 'Save transfer'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
