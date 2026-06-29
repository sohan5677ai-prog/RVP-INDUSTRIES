import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, ArrowRight } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { StockTransfer, SiloInventory, BunkerPlace, LoansResponse } from '@/lib/types';
import {
  transferHamali,
  TRANSFER_STORAGE_UNLOAD_RATE, TRANSFER_STORAGE_UNLOAD_MARGIN, TRANSFER_HANDLING_RATE, TRANSFER_TRANSPORT,
  loanInterest, daysBetween,
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

const STORAGES = ['Rampalli', 'Murgan', 'Multi'] as const;

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

  // Loan summary drives the bank-interest preview (rate + earliest open loan).
  const { data: loanData } = useQuery({
    queryKey: ['loans'],
    queryFn: () => api<LoansResponse>('/loans'),
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

  // Bank-loan carrying interest preview. Seed value moved is estimated from the
  // source silo's MAP; days run from the earliest open loan's drawdown date.
  const loanRate = loanData?.summary.rate ?? 0;
  const earliestOpenLoanDate = loanData?.summary.earliestOpenLoanDate ?? null;
  const interestDays = earliestOpenLoanDate
    ? daysBetween(new Date(earliestOpenLoanDate), new Date(transferDate))
    : 0;
  const srcSilo = fromLocation ? storageSilo(fromLocation) : undefined;
  const srcMap = srcSilo && srcSilo.weightKg > 0 ? Number(srcSilo.totalValue) / srcSilo.weightKg : 0;
  const estSeedValue = weightValid ? srcMap * weightKg : 0;
  const interestCharge = weightValid && interestDays > 0 ? loanInterest(estSeedValue, loanRate, interestDays) : 0;

  const totalAdded = hamali.charge + transportCharge + interestCharge;

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
            Move black seed from a storage (Rampalli/Murgan/Multi) to the process. Adds a fixed hamali
            (₹{TRANSFER_STORAGE_UNLOAD_RATE}/t storage unload + ₹{TRANSFER_HANDLING_RATE}/t load &amp; unload),
            and ₹{TRANSFER_TRANSPORT} transport to the seed's value.
          </p>
        </div>
        <Button onClick={() => { resetForm(); setOpen(true); }}>
          <Plus className="h-4 w-4" /> Record Transfer
        </Button>
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

              <TableHead className="text-right">Interest</TableHead>
              <TableHead className="text-right">Moved value</TableHead>
              <TableHead className="w-16 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow><TableCell colSpan={10} className="text-center text-muted-foreground">Loading…</TableCell></TableRow>
            )}
            {transfers?.length === 0 && (
              <TableRow><TableCell colSpan={10} className="text-center text-muted-foreground">No transfers yet.</TableCell></TableRow>
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
                <TableCell className="text-right">{rupees(Number(t.loadingHamali) + Number(t.unloadingHamali))}</TableCell>
                <TableCell className="text-right">{rupees(t.transportCharge)}</TableCell>

                <TableCell className="text-right">
                  {Number(t.interestCharge) > 0 ? (
                    <>{rupees(t.interestCharge)}<span className="block text-[10px] text-muted-foreground">{t.interestDays} days @ {Number(t.interestRatePct)}%</span></>
                  ) : '—'}
                </TableCell>
                <TableCell className="text-right font-semibold">{rupees(t.movedValue)}</TableCell>
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
                    <SelectItem key={loc} value={loc}>{loc} — {kg(storageStock(loc))} available</SelectItem>
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
                <span className="text-muted-foreground">Storage unload hamali (₹{TRANSFER_STORAGE_UNLOAD_RATE}/t)</span>
                <span className="font-medium">{rupees(hamali.unloadCharge)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Load &amp; unload hamali (₹{TRANSFER_HANDLING_RATE}/t)</span>
                <span className="font-medium">{rupees(hamali.handlingCharge)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Transfer transport (fixed)</span>
                <span className="font-medium">{rupees(transportCharge)}</span>
              </div>

              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  Bank-loan interest {interestDays > 0 ? `(${interestDays} days @ ${loanRate}%)` : '(no open loan)'}
                </span>
                <span className="font-medium">{interestCharge > 0 ? rupees(interestCharge) : '—'}</span>
              </div>
              <div className="flex justify-between border-t pt-2">
                <span className="text-muted-foreground font-semibold">Cost added to seed</span>
                <span className="font-bold text-primary">{weightValid ? rupees(totalAdded) : '—'}</span>
              </div>
              <p className="text-[11px] text-muted-foreground pt-1 border-t mt-1">
                Of the ₹{TRANSFER_STORAGE_UNLOAD_RATE}/t storage-unload hamali, ₹{TRANSFER_STORAGE_UNLOAD_RATE - TRANSFER_STORAGE_UNLOAD_MARGIN}/t is paid to the crew and ₹{TRANSFER_STORAGE_UNLOAD_MARGIN}/t is company hamali profit. The ₹{TRANSFER_HANDLING_RATE}/t load &amp; unload is fully crew. All costs are capitalised into the seed at the process.
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
