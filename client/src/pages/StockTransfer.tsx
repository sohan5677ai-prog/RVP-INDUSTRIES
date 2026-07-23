import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, ArrowRight } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { StockTransfer } from '@/lib/types';
import {
  transferHamali, transferTransportCharge, transferTransportRate,
  TRANSFER_HANDLING_RATE,
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
  { header: 'Loan Interest', value: (t) => rupees(t.interestCharge), excel: (t) => Number(t.interestCharge), numFmt: '#,##0.00', align: 'right' },
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

  // Physical black-seed stock per location, computed the SAME way as the Stock by
  // Location page: RVP kata net weight received (excluding synthetic transfer-in
  // rows) − transfers out + transfers in. The SiloInventory aggregate is NOT used
  // here because at verification it stores the exempted `finalWeightKg` (the higher
  // reference weight the supplier is paid for), which over-counts physical stock by
  // the forgiven ≤80 kg shortages. Using kata net keeps these storage figures in
  // lock-step with Stock by Location, which values physical kata weight.
  const { data: seedData } = useQuery({
    queryKey: ['black-seed-stock'],
    queryFn: () => api<{ rows: { rvpNetWeightKg: number; location: string; isTransferredIn?: boolean }[] }>('/inventory/black-seed'),
  });

  // Storage carrying interest is a flat 1% per month (shown monthly to match the
  // Bank Loans page), day-prorated per lot by its storage dwell on save.

  const storageStock = (loc: string) => {
    const received = (seedData?.rows ?? [])
      .filter((r) => !r.isTransferredIn && (r.location || 'RVP') === loc)
      .reduce((s, r) => s + r.rvpNetWeightKg, 0);
    const out = (transfers ?? [])
      .filter((t) => t.fromLocation === loc)
      .reduce((s, t) => s + t.weightKg, 0);
    const inbound = (transfers ?? [])
      .filter((t) => t.toLocation === loc)
      .reduce((s, t) => s + t.weightKg, 0);
    return received - out + inbound;
  };

  const [fromLocation, setFromLocation] = useState<string>('');
  const [weight, setWeight] = useState('');
  const [lorryNumber, setLorryNumber] = useState('');
  const [transferDate, setTransferDate] = useState(() => new Date().toISOString().slice(0, 10));

  const weightKg = Number(weight) || 0;
  const available = fromLocation ? storageStock(fromLocation) : 0;
  const weightValid = weightKg > 0 && weightKg <= available;

  const hamali = weightValid ? transferHamali(weightKg) : { unloadCharge: 0, handlingCharge: 0, charge: 0, crew: 0, margin: 0 };

  const transportCharge = weightValid ? transferTransportCharge(weightKg, fromLocation) : 0;

  // Live costing preview from the server: the storage carrying interest depends on
  // the specific price band(s) drawn and each lot's days in storage, which only the
  // server can resolve. Runs the exact same band-draw + interest accrual as save,
  // without persisting, so the dialog can show the interest and its dwell days.
  const { data: preview, isFetching: previewLoading } = useQuery({
    queryKey: ['stock-transfer-preview', fromLocation, weightKg, transferDate],
    queryFn: () =>
      api<{
        seedCostMoved: number;
        hamaliCharge: number;
        transportCharge: number;
        interestCharge: number;
        interestDays: number;
        interestRatePct: number;
        movedValue: number;
      }>(`/stock-transfers/preview?fromLocation=${encodeURIComponent(fromLocation)}&weightKg=${weightKg}&transferDate=${transferDate}`),
    enabled: open && weightValid,
  });

  // The carrying-interest rate is the global storage-loan rate (Bank Loans page).
  // Fetched here so the dialog can label the rate even before a preview loads; the
  // preview's own interestRatePct is authoritative once it arrives. Stored annual,
  // shown monthly to match the Bank Loans page convention.
  const { data: loanSettings } = useQuery({
    queryKey: ['loan-settings'],
    queryFn: () => api<{ loanInterestRatePct: number }>('/loans/settings'),
  });
  const annualRate = preview?.interestRatePct ?? loanSettings?.loanInterestRatePct;
  const monthlyRate = annualRate != null ? Math.round((annualRate / 12) * 1000) / 1000 : null;


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
      qc.invalidateQueries({ queryKey: ['black-seed-stock'] });
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
      qc.invalidateQueries({ queryKey: ['black-seed-stock'] });
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
            (₹{TRANSFER_HANDLING_RATE}/t load &amp; unload), and per-tonne transport (₹250/t PGR COLD &amp; Murugan, ₹100/t KNM Multi, billed to KNM Transport) to the seed's value.
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
              <TableHead className="text-right">Loan interest</TableHead>
              <TableHead className="text-right">Moved value</TableHead>
              <TableHead className="text-right">Price/kg</TableHead>
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
                <TableCell className="font-mono text-xs">{t.lorryNumber ?? '-'}</TableCell>
                <TableCell className="text-right">{kg(t.weightKg)}</TableCell>
                <TableCell className="text-right">{rupees(Number(t.loadingHamali) + Number(t.unloadingHamali))}</TableCell>
                <TableCell className="text-right">{rupees(t.transportCharge)}</TableCell>
                <TableCell className="text-right">
                  {Number(t.interestCharge) > 0 ? (
                    <span title={`${t.interestDays} days since loan @ ${Number(t.interestRatePct) / 12}%/mo`}>{rupees(t.interestCharge)}</span>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </TableCell>
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
                <span className="text-muted-foreground">Transfer transport (₹{transferTransportRate(fromLocation)}/t → KNM Transport)</span>
                <span className="font-medium">{rupees(transportCharge)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  Loan carrying interest ({monthlyRate ?? '…'}%/mo
                  {preview && preview.interestDays > 0 ? ` · ${preview.interestDays} day${preview.interestDays === 1 ? '' : 's'} since loan` : ''})
                </span>
                <span className="font-medium">
                  {!weightValid ? '—' : previewLoading && !preview ? 'Calculating…' : preview ? rupees(preview.interestCharge) : '—'}
                </span>
              </div>
              {preview && weightValid && (
                <>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Seed value drawn (from price band)</span>
                    <span className="font-medium">{rupees(preview.seedCostMoved)}</span>
                  </div>
                  <div className="flex justify-between border-t pt-2 mt-1">
                    <span className="text-muted-foreground font-medium">Moved value at destination</span>
                    <span className="font-semibold">{rupees(preview.movedValue)}</span>
                  </div>
                </>
              )}
              <p className="text-[11px] text-muted-foreground pt-1 border-t mt-1">
                Seed value is drawn from the specific price band(s) at {fromLocation || 'the source'}, top-to-bottom (highest price first) - landed cost excluding GST - and finalised on save (see the <span className="font-medium">Moved value</span> column). The ₹{TRANSFER_HANDLING_RATE}/t hamali (fully paid to the crew), ₹{transferTransportRate(fromLocation)}/t transport (billed to KNM Transport), and carrying interest at the storage-loan rate of {monthlyRate ?? '…'}% per month (set on the Bank Loans page, accrued per lot by its days from the loan availed date) are capitalised into that seed value.
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
