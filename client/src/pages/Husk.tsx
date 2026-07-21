import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Layers, Plus, Trash2, ArrowRight, Package } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { HuskTransfer } from '@/lib/types';
import { shellTransferCost, SHELL_HAMALI_RATE, transferTransportRate } from '@/lib/calc';
import { kg, rupees, shortDate, toTonnes } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import { Button } from '@/components/ui/button';
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

const HUSK_TRANSFER_COLUMNS: ExportColumn<HuskTransfer>[] = [
  { header: 'Date', value: (t) => shortDate(t.transferDate) },
  { header: 'Route', value: (t) => `${t.fromLocation} → ${t.toLocation}` },
  { header: 'Lorry', value: (t) => t.lorryNumber ?? '' },
  { header: 'Weight (kg)', value: (t) => t.weightKg, numFmt: '#,##0', align: 'right' },
  { header: 'Hamali', value: (t) => rupees(t.hamaliCharge), excel: (t) => Number(t.hamaliCharge), numFmt: '#,##0.00', align: 'right' },
  { header: 'Transport', value: (t) => rupees(t.transportCharge), excel: (t) => Number(t.transportCharge), numFmt: '#,##0.00', align: 'right' },
  { header: 'Total Cost', value: (t) => rupees(t.totalCost), excel: (t) => Number(t.totalCost), numFmt: '#,##0.00', align: 'right' },
];

// The storage locations husk can be moved to (RVP is the source factory).
const HUSK_STORAGES = ['PGR COLD', 'Murugan', 'KNM Multi'] as const;

/**
 * Husk detail. Sales is the standard dispatch → invoice → deliver flow. Transfers
 * move our own husk from the factory to one of three storage locations, expensing
 * the same ₹333/t hamali + ₹500 transport as the pre-cleaner dust transfers.
 */
export default function Husk() {
  return (
    <div className="space-y-6">
      <PageHeader
        icon={Layers}
        title="Husk"
        description="Sell husk through the full dispatch lifecycle, or transfer it to a storage location."
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

// ── Transfers: move our own husk to a storage location ────────────────────────
function TransfersPanel() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data: transfers, isLoading } = useQuery({
    queryKey: ['husk-transfers'],
    queryFn: () => api<HuskTransfer[]>('/husk-transfers'),
  });

  const transferredKg = (transfers ?? []).reduce((sum, t) => sum + t.weightKg, 0);
  const totalCost = (transfers ?? []).reduce((sum, t) => sum + Number(t.totalCost), 0);

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
      toast.success('Husk transfer reversed');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 stagger">
        <StatCard label="Total husk transferred" value={`${toTonnes(transferredKg).toFixed(2)} MT`} icon={Package} tone="amber" hint={`${kg(transferredKg)} moved to storage`} />
        <StatCard label="Transfer cost" value={rupees(totalCost)} icon={ArrowRight} tone="forest" hint="hamali + transport, expensed" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Factory → storage transfers · hamali ₹{SHELL_HAMALI_RATE}/t + per-tonne transport (₹250/t PGR COLD &amp; Murugan, ₹100/t KNM Multi) billed to KNM Transport.
        </p>
        <div className="flex items-center gap-2">
          <ExportButtons filename="Husk_Transfers" title="Husk Transfers" subtitle={`${transfers?.length ?? 0} transfer(s)`} columns={HUSK_TRANSFER_COLUMNS} rows={transfers ?? []} />
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
              <TableRow><TableCell colSpan={8} className="h-28 text-center text-muted-foreground">No husk transfers yet.</TableCell></TableRow>
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
                      if (confirm(`Reverse this transfer? ${t.weightKg} kg of husk leaves ${t.toLocation}.`)) {
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
