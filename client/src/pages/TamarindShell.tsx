import { useState } from 'react';
import SalesProduct from './SalesProduct';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, ArrowRight, Package } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { ShellTransfer, SiloInventory, SaleOrder } from '@/lib/types';
import { shellTransferCost, SHELL_HAMALI_RATE, SHELL_TRANSPORT } from '@/lib/calc';
import { kg, rupees, shortDate, toTonnes } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const SHELL_STORAGE = 'Rampalli';

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
    .reduce((sum, o) => sum + (o.dispatchedKg ?? 0), 0);

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
      <PageHeader
        icon={Package}
        title="Tamarind Shell"
        description={`Shell comes out during production. Transfer it from the factory to ${SHELL_STORAGE}, then sell from that stock.`}
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 stagger">
        <StatCard label={`Stock at ${SHELL_STORAGE}`} value={`${toTonnes(stockKg).toFixed(2)} MT`} icon={Package} tone="amber" hint={`${kg(stockKg)} · ${rupees(stockValue)}`} />
        <StatCard label="Total sold" value={`${toTonnes(soldKg).toFixed(2)} MT`} icon={ArrowRight} tone="forest" hint="dispatched shell shipments" />
        <StatCard label="Avg cost" value={stockKg > 0 ? `${rupees(stockValue / stockKg)}/kg` : '—'} icon={Package} tone="taupe" hint={`moving average at ${SHELL_STORAGE}`} />
      </div>

      <Tabs defaultValue="sales" className="gap-4">
        <TabsList>
          <TabsTrigger value="sales">Sales</TabsTrigger>
          <TabsTrigger value="transfers">Transfers</TabsTrigger>
        </TabsList>

        {/* Sales */}
        <TabsContent value="sales">
          <SalesProduct product="SHELL" hideHeader />
        </TabsContent>

        {/* Transfers */}
        <TabsContent value="transfers" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              Factory → {SHELL_STORAGE} transfers · hamali ₹{SHELL_HAMALI_RATE}/t + ₹{SHELL_TRANSPORT} transport.
            </p>
            <Button onClick={() => { resetForm(); setOpen(true); }}>
              <Plus className="h-4 w-4" /> Record Transfer
            </Button>
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
                  <TableRow><TableCell colSpan={8} className="h-28 text-center text-muted-foreground">No shell transfers yet.</TableCell></TableRow>
                )}
                {transfers?.map((t) => (
                  <TableRow key={t.id} className="group">
                    <TableCell className="text-muted-foreground">{shortDate(t.transferDate)}</TableCell>
                    <TableCell className="font-medium">
                      <span className="inline-flex items-center gap-1.5">
                        {t.fromLocation} <ArrowRight className="h-3 w-3 text-muted-foreground" /> {t.toLocation}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{t.lorryNumber ?? '—'}</TableCell>
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
                          if (confirm(`Reverse this transfer? ${t.weightKg} kg of shell leaves ${t.toLocation}.`)) {
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
        </TabsContent>
      </Tabs>

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
