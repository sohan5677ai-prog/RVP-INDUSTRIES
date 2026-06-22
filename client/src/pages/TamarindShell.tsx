import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, ArrowRight, Package } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { ShellTransfer, SiloInventory, SaleOrder, SaleStatus } from '@/lib/types';
import { shellTransferCost, SHELL_HAMALI_RATE, SHELL_TRANSPORT } from '@/lib/calc';
import { kg, rupees, shortDate, toTonnes } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';

const SHELL_STORAGE = 'Rampalli';

const statusVariant: Record<SaleStatus, 'default' | 'secondary' | 'outline'> = {
  PENDING: 'secondary',
  DISPATCHED: 'default',
  REACHED: 'outline',
};

export default function TamarindShell() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data: transfers, isLoading } = useQuery({
    queryKey: ['shell-transfers'],
    queryFn: () => api<ShellTransfer[]>('/shell-transfers'),
  });
  const { data: silos } = useQuery({
    queryKey: ['silos'],
    queryFn: () => api<SiloInventory[]>('/inventory/silos'),
  });
  const { data: orders } = useQuery({
    queryKey: ['sale-orders', 'SHELL'],
    queryFn: () => api<SaleOrder[]>('/sale-orders?product=SHELL'),
  });

  const shellSilo = silos?.find((s) => s.itemType === 'TAMARIND_SHELL' && s.location === SHELL_STORAGE);
  const stockKg = shellSilo?.weightKg ?? 0;
  const stockValue = Number(shellSilo?.totalValue ?? 0);
  const soldKg = (orders ?? [])
    .filter((o) => o.status !== 'PENDING')
    .reduce((sum, o) => sum + o.tonnageKg, 0);

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
      toast.success('Shell transfer recorded');
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
      toast.success('Shell transfer reversed');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Tamarind Shell</h1>
          <p className="text-muted-foreground">
            Shell comes out during production. Transfer it from the factory to {SHELL_STORAGE} (hamali ₹{SHELL_HAMALI_RATE}/t
            + ₹{SHELL_TRANSPORT} transport), then sell from that stock. Create shell sale orders on the Sale Orders page.
          </p>
        </div>
        <Button onClick={() => { resetForm(); setOpen(true); }}>
          <Plus className="h-4 w-4" /> Record Transfer
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Stock at {SHELL_STORAGE}</CardTitle>
            <Package className="h-4 w-4 text-amber-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-amber-600">{toTonnes(stockKg).toFixed(2)} MT</div>
            <p className="text-[10px] text-muted-foreground mt-1">{kg(stockKg)} on hand · valued {rupees(stockValue)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Sold</CardTitle>
            <ArrowRight className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-emerald-600">{toTonnes(soldKg).toFixed(2)} MT</div>
            <p className="text-[10px] text-muted-foreground mt-1">across dispatched/reached shell orders</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Avg Cost</CardTitle>
            <Package className="h-4 w-4 text-stone-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-stone-600">{stockKg > 0 ? `${rupees(stockValue / stockKg)}/kg` : '—'}</div>
            <p className="text-[10px] text-muted-foreground mt-1">moving average at {SHELL_STORAGE}</p>
          </CardContent>
        </Card>
      </div>

      {/* Transfers */}
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2">Factory → {SHELL_STORAGE} transfers</h2>
        <div className="rounded-lg border bg-card overflow-x-auto">
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
                <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground">Loading…</TableCell></TableRow>
              )}
              {transfers?.length === 0 && (
                <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-6">No shell transfers yet.</TableCell></TableRow>
              )}
              {transfers?.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>{shortDate(t.transferDate)}</TableCell>
                  <TableCell className="font-medium">
                    <span className="inline-flex items-center gap-1">
                      {t.fromLocation} <ArrowRight className="h-3 w-3" /> {t.toLocation}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{t.lorryNumber ?? '—'}</TableCell>
                  <TableCell className="text-right">{kg(t.weightKg)}</TableCell>
                  <TableCell className="text-right">{rupees(t.hamaliCharge)}</TableCell>
                  <TableCell className="text-right">{rupees(t.transportCharge)}</TableCell>
                  <TableCell className="text-right font-semibold">{rupees(t.totalCost)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        if (confirm(`Reverse this transfer? ${t.weightKg} kg of shell leaves ${t.toLocation}.`)) {
                          deleteMutation.mutate(t.id);
                        }
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Shell sales */}
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2">Shell sales</h2>
        <div className="rounded-lg border bg-card overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Invoice No</TableHead>
                <TableHead>Party</TableHead>
                <TableHead>Destination</TableHead>
                <TableHead className="text-right">Weight</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(orders ?? []).length === 0 && (
                <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-6">No shell sales yet.</TableCell></TableRow>
              )}
              {orders?.map((o) => {
                const price = Number(o.ratePerKg);
                const val = o.tonnageKg * price + Number(o.gstAmount);
                return (
                  <TableRow key={o.id}>
                    <TableCell>{shortDate(o.saleDate)}</TableCell>
                    <TableCell className="font-mono text-sm">{o.invoiceNumber ?? '—'}</TableCell>
                    <TableCell className="font-medium">{o.buyer?.name ?? '—'}</TableCell>
                    <TableCell>{o.destination ?? '—'}</TableCell>
                    <TableCell className="text-right font-semibold">{toTonnes(o.tonnageKg).toFixed(2)} t</TableCell>
                    <TableCell className="text-right">{rupees(price)}/kg</TableCell>
                    <TableCell className="text-right font-semibold text-emerald-600">{rupees(val)}</TableCell>
                    <TableCell><Badge variant={statusVariant[o.status]}>{o.status}</Badge></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Record Shell Transfer</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="sweight">Weight to move (kg)</Label>
              <Input id="sweight" type="number" value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="e.g. 5000" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="slorry">Lorry number</Label>
                <Input id="slorry" value={lorryNumber} onChange={(e) => setLorryNumber(e.target.value)} placeholder="AP02AB1234" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sdate">Transfer date</Label>
                <Input id="sdate" type="date" value={transferDate} onChange={(e) => setTransferDate(e.target.value)} />
              </div>
            </div>

            <div className="rounded-lg border bg-muted/40 p-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Hamali (₹{SHELL_HAMALI_RATE}/t — pack, load &amp; unload)</span>
                <span className="font-medium">{rupees(cost.hamaliCharge)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Transport (fixed)</span>
                <span className="font-medium">{rupees(cost.transportCharge)}</span>
              </div>
              <div className="flex justify-between border-t pt-2">
                <span className="text-muted-foreground font-semibold">Cost capitalised at {SHELL_STORAGE}</span>
                <span className="font-bold text-primary">{weightValid ? rupees(cost.totalCost) : '—'}</span>
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
