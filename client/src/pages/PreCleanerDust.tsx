import { useState } from 'react';
import SalesProduct from './SalesProduct';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, ArrowRight, Package, ShoppingCart, IndianRupee } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { ShellTransfer, SaleOrder, DustPurchase, Party } from '@/lib/types';
import { shellTransferCost, SHELL_HAMALI_RATE, SHELL_TRANSPORT } from '@/lib/calc';
import { kg, rupees, shortDate, toTonnes } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { StatCard } from '@/components/StatCard';
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

const DUST_STORAGE = 'PGR COLD';

const DUST_PURCHASE_COLUMNS: ExportColumn<DustPurchase>[] = [
  { header: 'Date', value: (p) => shortDate(p.purchaseDate) },
  { header: 'Party', value: (p) => p.party?.name ?? '' },
  { header: 'Invoice', value: (p) => p.invoiceNumber ?? '' },
  { header: 'Lorry', value: (p) => p.lorryNumber ?? '' },
  { header: 'Weight (kg)', value: (p) => p.weightKg, numFmt: '#,##0', align: 'right' },
  { header: 'Price/kg', value: (p) => rupees(p.pricePerKg), excel: (p) => Number(p.pricePerKg), numFmt: '#,##0.00', align: 'right' },
  { header: 'Amount', value: (p) => rupees(p.amount), excel: (p) => Number(p.amount), numFmt: '#,##0.00', align: 'right' },
];

const DUST_TRANSFER_COLUMNS: ExportColumn<ShellTransfer>[] = [
  { header: 'Date', value: (t) => shortDate(t.transferDate) },
  { header: 'Route', value: (t) => `${t.fromLocation} → ${t.toLocation}` },
  { header: 'Lorry', value: (t) => t.lorryNumber ?? '' },
  { header: 'Weight (kg)', value: (t) => t.weightKg, numFmt: '#,##0', align: 'right' },
  { header: 'Hamali', value: (t) => rupees(t.hamaliCharge), excel: (t) => Number(t.hamaliCharge), numFmt: '#,##0.00', align: 'right' },
  { header: 'Transport', value: (t) => rupees(t.transportCharge), excel: (t) => Number(t.transportCharge), numFmt: '#,##0.00', align: 'right' },
  { header: 'Total Cost', value: (t) => rupees(t.totalCost), excel: (t) => Number(t.totalCost), numFmt: '#,##0.00', align: 'right' },
];

/**
 * Pre Cleaner Dust detail. Purchases record dust bought IN from an outside party
 * (raises a real supplier payable → shows on the party ledger). Transfers only
 * move our own byproduct to storage (reuses the shell-transfers backend). Sales is
 * the standard dispatch → invoice → deliver flow.
 */
export default function PreCleanerDust() {
  return (
    <div className="space-y-6">
      <Tabs defaultValue="purchases" className="gap-4">
        <TabsList>
          <TabsTrigger value="purchases">Purchases</TabsTrigger>
          <TabsTrigger value="transfers">Transfers</TabsTrigger>
          <TabsTrigger value="sales">Sales</TabsTrigger>
        </TabsList>

        <TabsContent value="purchases">
          <PurchasesPanel />
        </TabsContent>
        <TabsContent value="transfers">
          <TransfersPanel />
        </TabsContent>
        <TabsContent value="sales">
          <SalesProduct product="PRECLEANER_DUST" hideHeader />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Purchases: dust bought from an outside party (real supplier payable) ──────
function PurchasesPanel() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data: purchases, isLoading } = useQuery({
    queryKey: ['dust-purchases'],
    queryFn: () => api<DustPurchase[]>('/dust-purchases'),
  });
  const { data: parties } = useQuery({
    queryKey: ['parties'],
    queryFn: () => api<Party[]>('/parties'),
  });

  const supplierOptions = (parties ?? [])
    .filter((p) => p.type !== 'BUYER' && p.type !== 'HAMALI_TEAM')
    .map((p) => ({ value: p.id, label: p.name }));

  const boughtKg = (purchases ?? []).reduce((s, p) => s + p.weightKg, 0);
  const payableTotal = (purchases ?? []).reduce((s, p) => s + Number(p.amount), 0);

  const [partyId, setPartyId] = useState('');
  const [weight, setWeight] = useState('');
  const [price, setPrice] = useState('');
  const [lorryNumber, setLorryNumber] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [purchaseDate, setPurchaseDate] = useState(() => new Date().toISOString().slice(0, 10));

  const weightKg = Number(weight) || 0;
  const pricePerKg = Number(price) || 0;
  const amount = Math.round(weightKg * pricePerKg * 100) / 100;
  const valid = !!partyId && weightKg > 0 && pricePerKg > 0;

  function resetForm() {
    setPartyId('');
    setWeight('');
    setPrice('');
    setLorryNumber('');
    setInvoiceNumber('');
    setPurchaseDate(new Date().toISOString().slice(0, 10));
  }

  const mutation = useMutation({
    mutationFn: () =>
      api<DustPurchase>('/dust-purchases', {
        method: 'POST',
        body: {
          partyId,
          weightKg,
          pricePerKg,
          lorryNumber: lorryNumber || null,
          invoiceNumber: invoiceNumber || null,
          purchaseDate,
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dust-purchases'] });
      qc.invalidateQueries({ queryKey: ['party-ledgers'] });
      qc.invalidateQueries({ queryKey: ['party-ledger'] });
      toast.success('Dust purchase recorded');
      setOpen(false);
      resetForm();
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/dust-purchases/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dust-purchases'] });
      qc.invalidateQueries({ queryKey: ['party-ledgers'] });
      qc.invalidateQueries({ queryKey: ['party-ledger'] });
      toast.success('Dust purchase reversed');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 stagger">
        <StatCard label="Total dust purchased" value={`${toTonnes(boughtKg).toFixed(2)} MT`} icon={Package} tone="amber" hint={`${kg(boughtKg)} bought in`} />
        <StatCard label="Payable to suppliers" value={rupees(payableTotal)} icon={IndianRupee} tone="forest" hint="raised on the party ledger" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Pre-cleaner dust bought from an outside party · each purchase raises a supplier payable.
        </p>
        <div className="flex items-center gap-2">
          <ExportButtons filename="PreCleaner_Dust_Purchases" title="Pre Cleaner Dust Purchases" subtitle={`${purchases?.length ?? 0} purchase(s)`} columns={DUST_PURCHASE_COLUMNS} rows={purchases ?? []} />
          <Button onClick={() => { resetForm(); setOpen(true); }}>
            <Plus className="h-4 w-4" /> Record Purchase
          </Button>
        </div>
      </div>
      <div className="glass rounded-2xl overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Party</TableHead>
              <TableHead>Invoice</TableHead>
              <TableHead>Lorry</TableHead>
              <TableHead className="text-right">Weight</TableHead>
              <TableHead className="text-right">Price/kg</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="w-16 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow><TableCell colSpan={8} className="h-24 text-center text-muted-foreground">Loading…</TableCell></TableRow>
            )}
            {purchases?.length === 0 && (
              <TableRow><TableCell colSpan={8} className="h-28 text-center text-muted-foreground">No dust purchases yet.</TableCell></TableRow>
            )}
            {purchases?.map((p) => (
              <TableRow key={p.id} className="group">
                <TableCell className="text-muted-foreground">{shortDate(p.purchaseDate)}</TableCell>
                <TableCell className="font-medium text-foreground">{p.party?.name ?? '-'}</TableCell>
                <TableCell className="font-mono text-xs">{p.invoiceNumber ?? '-'}</TableCell>
                <TableCell className="font-mono text-xs">{p.lorryNumber ?? '-'}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{kg(p.weightKg)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{rupees(p.pricePerKg)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums font-semibold">{rupees(p.amount)}</TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="opacity-60 transition-opacity group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => {
                      if (confirm(`Reverse this purchase? ${rupees(p.amount)} payable to ${p.party?.name ?? 'the party'} will be removed.`)) {
                        deleteMutation.mutate(p.id);
                      }
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Record Dust Purchase</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Supplier</Label>
              <Combobox
                options={supplierOptions}
                value={partyId}
                onChange={setPartyId}
                placeholder="Select party…"
                searchPlaceholder="Search party…"
                ariaLabel="Select supplier"
                className="w-full"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="dpweight">Weight (kg)</Label>
                <Input id="dpweight" type="number" value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="e.g. 5000" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="dpprice">Price (₹/kg)</Label>
                <Input id="dpprice" type="number" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="e.g. 8.50" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="dpinvoice">Invoice no (optional)</Label>
                <Input id="dpinvoice" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} placeholder="INV-123" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="dplorry">Lorry (optional)</Label>
                <Input id="dplorry" value={lorryNumber} onChange={(e) => setLorryNumber(e.target.value)} placeholder="AP02AB1234" />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="dpdate">Purchase date</Label>
              <Input id="dpdate" type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} />
            </div>

            <div className="rounded-lg border bg-muted/40 p-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">{weightKg > 0 ? kg(weightKg) : '- kg'} × {pricePerKg > 0 ? rupees(pricePerKg) : '₹-'}</span>
                <span className="font-medium">{valid ? rupees(amount) : '-'}</span>
              </div>
              <div className="flex justify-between border-t pt-2">
                <span className="text-muted-foreground font-semibold">Payable to supplier</span>
                <span className="font-bold text-primary">{valid ? rupees(amount) : '-'}</span>
              </div>
            </div>

            <DialogFooter>
              <Button onClick={() => mutation.mutate()} disabled={!valid || mutation.isPending}>
                <ShoppingCart className="h-4 w-4" /> {mutation.isPending ? 'Saving…' : 'Save purchase'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Transfers: move our own byproduct to storage (shell-transfers backend) ────
function TransfersPanel() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data: transfers, isLoading } = useQuery({
    queryKey: ['shell-transfers'],
    queryFn: () => api<ShellTransfer[]>('/shell-transfers'),
  });
  const { data: orders } = useQuery({
    queryKey: ['sale-orders', 'PRECLEANER_DUST'],
    queryFn: () => api<SaleOrder[]>('/sale-orders?product=PRECLEANER_DUST'),
  });

  const transferredKg = (transfers ?? []).reduce((sum, t) => sum + t.weightKg, 0);
  const soldKg = (orders ?? []).reduce((sum, o) => sum + (o.dispatchedKg ?? 0), 0);

  const [weight, setWeight] = useState('');
  const [lorryNumber, setLorryNumber] = useState('');
  const [transferDate, setTransferDate] = useState(() => new Date().toISOString().slice(0, 10));

  const weightKg = Number(weight) || 0;
  const weightValid = weightKg > 0;
  const cost = weightValid ? shellTransferCost(weightKg) : { hamaliCharge: 0, transportCharge: 0, totalCost: 0 };

  function resetForm() {
    setWeight('');
    setLorryNumber('');
    setTransferDate(new Date().toISOString().slice(0, 10));
  }

  const mutation = useMutation({
    mutationFn: () =>
      api<ShellTransfer>('/shell-transfers', {
        method: 'POST',
        body: { weightKg, lorryNumber: lorryNumber || null, transferDate },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shell-transfers'] });
      qc.invalidateQueries({ queryKey: ['silos'] });
      toast.success('Dust transfer recorded');
      setOpen(false);
      resetForm();
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/shell-transfers/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shell-transfers'] });
      qc.invalidateQueries({ queryKey: ['silos'] });
      toast.success('Dust transfer reversed');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 stagger">
        <StatCard label={`Transferred to ${DUST_STORAGE}`} value={`${toTonnes(transferredKg).toFixed(2)} MT`} icon={Package} tone="amber" hint={`${kg(transferredKg)} moved to storage`} />
        <StatCard label="Total sold" value={`${toTonnes(soldKg).toFixed(2)} MT`} icon={ArrowRight} tone="forest" hint="dispatched dust shipments" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Factory → {DUST_STORAGE} transfers · hamali ₹{SHELL_HAMALI_RATE}/t + ₹{SHELL_TRANSPORT} transport.
        </p>
        <div className="flex items-center gap-2">
          <ExportButtons filename="PreCleaner_Dust_Transfers" title="Pre Cleaner Dust Transfers" subtitle={`${transfers?.length ?? 0} transfer(s)`} columns={DUST_TRANSFER_COLUMNS} rows={transfers ?? []} />
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
              <TableHead className="text-right">Weight</TableHead>
              <TableHead className="text-right">Hamali</TableHead>
              <TableHead className="text-right">Transport</TableHead>
              <TableHead className="text-right">Total cost</TableHead>
              <TableHead className="w-16 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow><TableCell colSpan={8} className="h-24 text-center text-muted-foreground">Loading…</TableCell></TableRow>
            )}
            {transfers?.length === 0 && (
              <TableRow><TableCell colSpan={8} className="h-28 text-center text-muted-foreground">No dust transfers yet.</TableCell></TableRow>
            )}
            {transfers?.map((t) => (
              <TableRow key={t.id} className="group">
                <TableCell className="text-muted-foreground">{shortDate(t.transferDate)}</TableCell>
                <TableCell className="font-medium">
                  <span className="inline-flex items-center gap-1.5">
                    {t.fromLocation} <ArrowRight className="h-3 w-3 text-muted-foreground" /> {t.toLocation}
                  </span>
                </TableCell>
                <TableCell className="font-mono text-xs">{t.lorryNumber ?? '-'}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{kg(t.weightKg)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{rupees(t.hamaliCharge)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{rupees(t.transportCharge)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums font-semibold">{rupees(t.totalCost)}</TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="opacity-60 transition-opacity group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => {
                      if (confirm(`Reverse this transfer? ${t.weightKg} kg of dust leaves ${t.toLocation}.`)) {
                        deleteMutation.mutate(t.id);
                      }
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Record Dust Transfer</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="dtweight">Weight to move (kg)</Label>
              <Input id="dtweight" type="number" value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="e.g. 5000" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="dtlorry">Lorry number</Label>
                <Input id="dtlorry" value={lorryNumber} onChange={(e) => setLorryNumber(e.target.value)} placeholder="AP02AB1234" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="dtdate">Transfer date</Label>
                <Input id="dtdate" type="date" value={transferDate} onChange={(e) => setTransferDate(e.target.value)} />
              </div>
            </div>

            <div className="rounded-lg border bg-muted/40 p-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Hamali (₹{SHELL_HAMALI_RATE}/t - pack, load &amp; unload)</span>
                <span className="font-medium">{rupees(cost.hamaliCharge)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Transport (fixed)</span>
                <span className="font-medium">{rupees(cost.transportCharge)}</span>
              </div>
              <div className="flex justify-between border-t pt-2">
                <span className="text-muted-foreground font-semibold">Cost capitalised at {DUST_STORAGE}</span>
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
