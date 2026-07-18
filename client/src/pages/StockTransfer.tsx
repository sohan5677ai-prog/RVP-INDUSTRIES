import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, ArrowRight } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { StockTransfer, SiloInventory } from '@/lib/types';
import {
  transferHamali,
  TRANSFER_HANDLING_RATE, TRANSFER_TRANSPORT,
} from '@/lib/calc';
import { kg, rupees, shortDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';

const STORAGES = ['PGR COLD', 'Murugan', 'KNM Multi'] as const;

const STOCK_TRANSFER_COLUMNS: ExportColumn<StockTransfer>[] = [
  { header: 'Date', value: (t) => shortDate(t.transferDate) },
  { header: 'Route', value: (t) => `${t.fromLocation} → ${t.toLocation}` },
  { header: 'Lorry', value: (t) => t.lorryNumber ?? '' },
  { header: 'Weight (kg)', value: (t) => t.weightKg, numFmt: '#,##0', align: 'right' },
  { header: 'Hamali', value: (t) => rupees(Number(t.loadingHamali) + Number(t.unloadingHamali)), excel: (t) => Number(t.loadingHamali) + Number(t.unloadingHamali), numFmt: '#,##0.00', align: 'right' },
  { header: 'Transport', value: (t) => rupees(t.transportCharge), excel: (t) => Number(t.transportCharge), numFmt: '#,##0.00', align: 'right' },
  { header: 'Moved Value', value: (t) => rupees(t.movedValue), excel: (t) => Number(t.movedValue), numFmt: '#,##0.00', align: 'right' },
  { header: 'Price/kg', value: (t) => (t.weightKg > 0 ? rupees(Number(t.movedValue) / t.weightKg) : ''), excel: (t) => (t.weightKg > 0 ? Number(t.movedValue) / t.weightKg : null), numFmt: '#,##0.00', align: 'right' },
];

export default function StockTransferPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data: transfers, isLoading } = useQuery({
    queryKey: ['stock-transfers'],
    queryFn: () => api<StockTransfer[]>('/stock-transfers'),
  });

  const { data: silos } = useQuery({
    queryKey: ['silos'],
    queryFn: () => api<SiloInventory[]>('/inventory/silos'),
  });

  const storageSilo = (loc: string) =>
    silos?.find((s) => s.itemType === 'BLACK_SEED' && s.location === loc);
  const storageStock = (loc: string) => storageSilo(loc)?.weightKg ?? 0;

  const [fromLocation, setFromLocation] = useState<string>('');
  const [weight, setWeight] = useState('');
  const [lorryNumber, setLorryNumber] = useState('');
  const [transferDate, setTransferDate] = useState(() => new Date().toISOString().slice(0, 10));

  const weightKg = Number(weight) || 0;
  const available = fromLocation ? storageStock(fromLocation) : 0;
  const weightValid = weightKg > 0 && weightKg <= available;

  const hamali = weightValid ? transferHamali(weightKg) : { unloadCharge: 0, handlingCharge: 0, charge: 0, crew: 0, margin: 0 };

  const transportCharge = weightValid ? TRANSFER_TRANSPORT : 0;

  // Hamali + transport travel with the seed and are capitalised into its value at
  // RVP. The seed's own value is drawn from the specific price band(s)
  // top-to-bottom on save (server-side), not a MAP estimate.

  function resetForm() {
    setFromLocation('');
    setWeight('');
    setLorryNumber('');
    setTransferDate(new Date().toISOString().slice(0, 10));
  }

  const mutation = useMutation({
    mutationFn: () =>
      api<StockTransfer>('/stock-transfers', {
        method: 'POST',
        body: {
          fromLocation,
          weightKg,
          lorryNumber: lorryNumber || null,
          transferDate,
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['stock-transfers'] });
      qc.invalidateQueries({ queryKey: ['silos'] });
      toast.success('Stock transfer recorded');
      setOpen(false);
      resetForm();
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/stock-transfers/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['stock-transfers'] });
      qc.invalidateQueries({ queryKey: ['silos'] });
      toast.success('Transfer reversed');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Stock Transfer</h1>
          <p className="text-muted-foreground">
            Move black seed from a storage (Rampalli/Murugan/Multi) to the process. Adds a fixed hamali
            (₹{TRANSFER_HANDLING_RATE}/t load &amp; unload), and ₹{TRANSFER_TRANSPORT} transport to the seed's value.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ExportButtons filename="Stock_Transfers" title="Stock Transfers" subtitle={`${transfers?.length ?? 0} transfer(s)`} columns={STOCK_TRANSFER_COLUMNS} rows={transfers ?? []} />
          <Button onClick={() => { resetForm(); setOpen(true); }}>
            <Plus className="h-4 w-4" /> Record Transfer
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {STORAGES.map((loc) => (
          <div key={loc} className="rounded-lg border bg-card p-4">
            <div className="text-sm text-muted-foreground">{loc}</div>
            <div className="text-xl font-bold">{kg(storageStock(loc))}</div>
            <div className="text-xs text-muted-foreground">black seed in storage</div>
          </div>
        ))}
      </div>

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
              <TableHead className="text-right">Moved value</TableHead>
              <TableHead className="text-right">Price/kg</TableHead>
              <TableHead className="w-16 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground">Loading…</TableCell></TableRow>
            )}
            {transfers?.length === 0 && (
              <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground">No transfers yet.</TableCell></TableRow>
            )}
            {transfers?.map((t) => (
              <TableRow key={t.id}>
                <TableCell>{shortDate(t.transferDate)}</TableCell>
                <TableCell className="font-medium">
                  <span className="inline-flex items-center gap-1">
                    {t.fromLocation} <ArrowRight className="h-3 w-3" /> {t.toLocation}
                  </span>
                </TableCell>
                <TableCell className="font-mono text-xs">{t.lorryNumber ?? '-'}</TableCell>
                <TableCell className="text-right">{kg(t.weightKg)}</TableCell>
                <TableCell className="text-right">{rupees(Number(t.loadingHamali) + Number(t.unloadingHamali))}</TableCell>
                <TableCell className="text-right">{rupees(t.transportCharge)}</TableCell>
                <TableCell className="text-right font-semibold">{rupees(t.movedValue)}</TableCell>
                <TableCell className="text-right font-semibold text-emerald-600">{t.weightKg > 0 ? rupees(Number(t.movedValue) / t.weightKg) : '-'}</TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      if (confirm(`Reverse this transfer? ${t.weightKg} kg moves back to ${t.fromLocation}.`)) {
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

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Record Stock Transfer</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>From storage</Label>
              <Select value={fromLocation} onValueChange={setFromLocation}>
                <SelectTrigger><SelectValue placeholder="Select storage" /></SelectTrigger>
                <SelectContent>
                  {STORAGES.map((loc) => (
                    <SelectItem key={loc} value={loc}>{loc} - {kg(storageStock(loc))} available</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="weight">Weight to move (kg)</Label>
              <Input id="weight" type="number" value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="e.g. 24000" />
              {fromLocation && weightKg > available && (
                <p className="text-xs text-destructive">Only {kg(available)} available at {fromLocation}.</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="lorry">Lorry number</Label>
                <Input id="lorry" value={lorryNumber} onChange={(e) => setLorryNumber(e.target.value)} placeholder="AP02AB1234" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tdate">Transfer date</Label>
                <Input id="tdate" type="date" value={transferDate} onChange={(e) => setTransferDate(e.target.value)} />
              </div>
            </div>


            <div className="rounded-lg border bg-muted/40 p-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Load &amp; unload hamali (₹{TRANSFER_HANDLING_RATE}/t)</span>
                <span className="font-medium">{rupees(hamali.handlingCharge)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Transfer transport (fixed)</span>
                <span className="font-medium">{rupees(transportCharge)}</span>
              </div>
              <p className="text-[11px] text-muted-foreground pt-1 border-t mt-1">
                Seed value is drawn from the specific price band(s) at {fromLocation || 'the source'}, top-to-bottom (highest price first) - landed cost excluding GST - and finalised on save (see the <span className="font-medium">Moved value</span> column). The ₹{TRANSFER_HANDLING_RATE}/t hamali (fully paid to the crew) and ₹{TRANSFER_TRANSPORT} transport are capitalised into that seed value.
              </p>
            </div>

            <DialogFooter>
              <Button onClick={() => mutation.mutate()} disabled={!fromLocation || !weightValid || mutation.isPending}>
                {mutation.isPending ? 'Saving…' : 'Save transfer'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
