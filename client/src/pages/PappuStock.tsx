import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowRight, Boxes, Package, Pencil, Plus, Trash2, TrendingDown, Warehouse } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { HamaliRate, PappuStockResponse, PappuStockSale, PappuStockTransfer } from '@/lib/types';
import { kg, rupees, shortDate, toTonnes } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';

/** Storages Pappu usually goes to. Any other name can be typed in. */
export const PAPPU_STORAGES = ['PGR COLD', 'Murugan', 'KNM Multi'] as const;
const DEFAULT_RATE = 270;

const mt = (kgValue: number) => `${toTonnes(kgValue).toFixed(2)} MT`;
const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();
const today = () => new Date().toISOString().slice(0, 10);

const TRANSFER_COLUMNS: ExportColumn<PappuStockTransfer>[] = [
  { header: 'Date', value: (t) => shortDate(t.date) },
  { header: 'Storage', value: (t) => t.toLocation },
  { header: 'Lorry', value: (t) => t.lorryNumber ?? '' },
  { header: 'Transferred (kg)', value: (t) => t.weightKg, numFmt: '#,##0', align: 'right' },
  { header: 'Sold from it (kg)', value: (t) => t.soldKg, numFmt: '#,##0', align: 'right' },
  { header: 'Left (kg)', value: (t) => t.remainingKg, numFmt: '#,##0', align: 'right' },
  { header: 'Hamali', value: (t) => rupees(t.hamaliAmount), excel: (t) => Number(t.hamaliAmount), numFmt: '#,##0.00', align: 'right' },
  { header: 'Note', value: (t) => t.note ?? '' },
];

const SALE_COLUMNS: ExportColumn<PappuStockSale>[] = [
  { header: 'Date', value: (s) => shortDate(s.dispatchDate) },
  { header: 'Invoice', value: (s) => s.invoiceNumber ?? 'Uninvoiced' },
  { header: 'Buyer', value: (s) => s.buyerName },
  { header: 'Storage', value: (s) => s.location },
  { header: 'Lorry', value: (s) => s.vehicleNumber ?? '' },
  { header: 'From storage (kg)', value: (s) => s.fromStorageKg, numFmt: '#,##0', align: 'right' },
  { header: 'Total lorry (kg)', value: (s) => s.totalWeightKg, numFmt: '#,##0', align: 'right' },
  { header: 'Status', value: (s) => titleCase(s.status) },
];

/**
 * Stock → Pappu Stock. Pappu moved from the mill to storage, what has been sold
 * back out of each storage, and how many tonnes are left where.
 *
 * A transfer recorded here is the same record as the "Pappu Transfer (Mill →
 * Storage)" hamali charge, so the ₹270/t crew charge is booked in the same step
 * and appears on the Hamali page. Sales draw stock down when the Pappu dispatch
 * is ticked "Dispatch from Transfers" with this storage.
 */
export default function PappuStock() {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['pappu-stock'],
    queryFn: () => api<PappuStockResponse>('/pappu-stock'),
  });
  const { data: hamaliRates } = useQuery({
    queryKey: ['hamali-rates'],
    queryFn: () => api<HamaliRate[]>('/settings/hamali-rates'),
    staleTime: 10 * 60 * 1000,
  });
  const rate = Number(hamaliRates?.find((r) => r.key === 'PAPPU_TRANSFER')?.ratePerTonne) || DEFAULT_RATE;

  const transfers = useMemo(() => data?.transfers ?? [], [data]);
  const sales = useMemo(() => data?.sales ?? [], [data]);

  const inKg = transfers.reduce((s, t) => s + t.weightKg, 0);
  const outKg = sales.reduce((s, x) => s + x.fromStorageKg, 0);
  const leftKg = inKg - outKg;
  const hamaliTotal = transfers.reduce((s, t) => s + Number(t.hamaliAmount), 0);

  // Per-storage balance. Known storages always show; any typed-in name joins them.
  const locations = useMemo(() => {
    const map = new Map<string, { name: string; inKg: number; outKg: number; lastIn: string | null }>();
    const keyOf = (n: string) => n.trim().toLowerCase();
    const touch = (name: string) => {
      const k = keyOf(name);
      if (!map.has(k)) map.set(k, { name, inKg: 0, outKg: 0, lastIn: null });
      return map.get(k)!;
    };
    PAPPU_STORAGES.forEach(touch);
    for (const t of transfers) {
      const row = touch(t.toLocation);
      row.inKg += t.weightKg;
      if (!row.lastIn || t.date > row.lastIn) row.lastIn = t.date;
    }
    for (const s of sales) touch(s.location).outKg += s.fromStorageKg;
    return [...map.values()]
      .filter((l) => l.inKg > 0 || l.outKg > 0 || (PAPPU_STORAGES as readonly string[]).includes(l.name))
      .map((l) => ({ ...l, balanceKg: l.inKg - l.outKg }));
  }, [transfers, sales]);

  const locationOptions = useMemo(
    () => [...new Set([...PAPPU_STORAGES, ...transfers.map((t) => t.toLocation).filter((l) => l !== 'Unassigned')])],
    [transfers],
  );

  // ── Record / edit dialogs ────────────────────────────────────────────────
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(today);
  const [tonnes, setTonnes] = useState('');
  const [toLocation, setToLocation] = useState<string>(PAPPU_STORAGES[0]);
  const [lorry, setLorry] = useState('');
  const [note, setNote] = useState('');
  const weightKg = Math.round((Number(tonnes) || 0) * 1000);
  const hamaliPreview = Math.round((weightKg / 1000) * rate * 100) / 100;
  const valid = weightKg > 0 && toLocation.trim() !== '' && !!date;

  function startRecord() {
    setDate(today());
    setTonnes('');
    setToLocation(PAPPU_STORAGES[0]);
    setLorry('');
    setNote('');
    setOpen(true);
  }

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['pappu-stock'] });
    qc.invalidateQueries({ queryKey: ['manual-hamali-costs'] });
    qc.invalidateQueries({ queryKey: ['accounts'] });
    qc.invalidateQueries({ queryKey: ['journal-entries'] });
  };

  const create = useMutation({
    mutationFn: () =>
      api('/pappu-stock/transfers', {
        method: 'POST',
        body: { date, weightKg, toLocation: toLocation.trim(), lorryNumber: lorry || null, ratePerTonne: rate, note: note || null },
      }),
    onSuccess: () => {
      invalidate();
      toast.success(`Transfer recorded - ${rupees(hamaliPreview)} hamali booked`);
      setOpen(false);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const [editing, setEditing] = useState<PappuStockTransfer | null>(null);
  const [eLocation, setELocation] = useState('');
  const [eLorry, setELorry] = useState('');
  const [eNote, setENote] = useState('');
  function startEdit(t: PappuStockTransfer) {
    setEditing(t);
    setELocation(t.toLocation === 'Unassigned' ? '' : t.toLocation);
    setELorry(t.lorryNumber ?? '');
    setENote(t.note ?? '');
  }
  const update = useMutation({
    mutationFn: () =>
      api(`/pappu-stock/transfers/${editing!.id}`, {
        method: 'PATCH',
        body: { toLocation: eLocation.trim(), lorryNumber: eLorry || null, note: eNote || null },
      }),
    onSuccess: () => {
      invalidate();
      toast.success('Transfer updated');
      setEditing(null);
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/pappu-stock/transfers/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidate();
      toast.success('Transfer reversed - its hamali charge is removed too');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e)),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Boxes}
        title="Pappu Stock"
        description="Pappu moved from the mill to storage, sold back out of storage, and the tonnes left in each place."
        actions={
          <Button onClick={startRecord}>
            <Plus className="h-4 w-4" /> Record Transfer
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 stagger">
        <StatCard label="Moved to storage" value={mt(inKg)} icon={Package} tone="amber" hint={`${transfers.length} transfer(s) · ${kg(inKg)}`} />
        <StatCard label="Sold from storage" value={mt(outKg)} icon={TrendingDown} tone="clay" hint={`${sales.length} lorry(s) · ${kg(outKg)}`} />
        <StatCard
          label="Pappu in storage now"
          value={mt(Math.max(0, leftKg))}
          icon={Warehouse}
          tone={leftKg > 0 ? 'forest' : 'taupe'}
          hint={leftKg < 0 ? `Over-sold by ${kg(-leftKg)} - check the storage on sales` : `${kg(Math.max(0, leftKg))} across storages`}
        />
        <StatCard label="Transfer hamali" value={rupees(hamaliTotal)} icon={ArrowRight} tone="forest" hint={`₹${rate}/t · on the Hamali page`} />
      </div>

      {/* Per-storage balances */}
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Stock by storage</h3>
          <p className="text-xs text-muted-foreground">Transferred in minus sold out, per storage.</p>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {locations.map((l) => {
            const pct = l.inKg > 0 ? Math.max(0, Math.min(100, (l.balanceKg / l.inKg) * 100)) : 0;
            return (
              <div key={l.name} className="glass space-y-3 rounded-xl border border-border/60 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Warehouse className="h-4 w-4" />
                    </div>
                    <div>
                      <span className="text-sm font-semibold">{l.name}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {l.lastIn ? `Last in ${shortDate(l.lastIn)}` : 'No transfers yet'}
                      </span>
                    </div>
                  </div>
                  <Badge
                    variant={l.balanceKg < 0 ? 'destructive' : l.balanceKg > 0 ? 'success' : 'outline'}
                    className="font-mono text-xs"
                  >
                    {mt(l.balanceKg)}
                  </Badge>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-emerald-600 transition-all duration-500" style={{ width: `${pct}%` }} />
                </div>
                <div className="grid grid-cols-2 gap-2 border-t border-border/40 pt-1 text-xs">
                  <div>
                    <span className="block text-[11px] text-muted-foreground">Transferred in</span>
                    <span className="font-mono font-medium">{mt(l.inKg)}</span>
                  </div>
                  <div className="text-right">
                    <span className="block text-[11px] text-muted-foreground">Sold out</span>
                    <span className="font-mono font-medium text-amber-700 dark:text-amber-400">{mt(l.outKg)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Transfers in */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Transfers (Mill → Storage)</h3>
            <p className="text-xs text-muted-foreground">
              Each transfer books Pappu Transfer hamali at ₹{rate}/t. Deleting one removes its hamali charge too.
            </p>
          </div>
          <ExportButtons
            filename="Pappu_Transfers"
            title="Pappu Transfers"
            subtitle={`${transfers.length} transfer(s)`}
            columns={TRANSFER_COLUMNS}
            rows={transfers}
          />
        </div>
        <div className="glass overflow-x-auto rounded-2xl">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Storage</TableHead>
                <TableHead>Lorry</TableHead>
                <TableHead className="text-right">Transferred</TableHead>
                <TableHead className="text-right">Sold from it</TableHead>
                <TableHead className="text-right">Left</TableHead>
                <TableHead className="text-right">Hamali</TableHead>
                <TableHead>Note</TableHead>
                <TableHead className="w-20 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={9} className="h-24 text-center text-muted-foreground">Loading…</TableCell></TableRow>
              )}
              {!isLoading && transfers.length === 0 && (
                <TableRow><TableCell colSpan={9} className="h-24 text-center text-muted-foreground">No Pappu transfers yet.</TableCell></TableRow>
              )}
              {transfers.map((t) => (
                <TableRow key={t.id} className="group">
                  <TableCell className="text-muted-foreground">{shortDate(t.date)}</TableCell>
                  <TableCell className="font-medium">
                    {t.toLocation === 'Unassigned' ? (
                      <button type="button" className="text-amber-700 underline-offset-2 hover:underline dark:text-amber-400" onClick={() => startEdit(t)}>
                        Set storage
                      </button>
                    ) : (
                      <span className="inline-flex items-center gap-1.5">
                        RVP Mill <ArrowRight className="h-3 w-3 text-muted-foreground" /> {t.toLocation}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{t.lorryNumber ?? '-'}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{mt(t.weightKg)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {t.soldKg > 0 ? <span className="font-medium text-amber-700 dark:text-amber-400">−{mt(t.soldKg)}</span> : <span className="text-muted-foreground">-</span>}
                  </TableCell>
                  <TableCell className="text-right">
                    <Badge
                      variant={t.remainingKg === 0 ? 'secondary' : t.remainingKg < t.weightKg ? 'warning' : 'success'}
                      className="font-mono text-[11px]"
                    >
                      {t.remainingKg === 0 ? 'Sold out' : mt(t.remainingKg)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{rupees(t.hamaliAmount)}</TableCell>
                  <TableCell className="max-w-[200px] truncate text-xs text-muted-foreground" title={t.note ?? ''}>{t.note ?? '-'}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon-sm" title="Edit storage / lorry / note" onClick={() => startEdit(t)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="hover:bg-destructive/10 hover:text-destructive"
                        title="Reverse transfer"
                        disabled={remove.isPending}
                        onClick={() => {
                          if (confirm(`Reverse this transfer? ${mt(t.weightKg)} leaves ${t.toLocation} and its ${rupees(t.hamaliAmount)} hamali charge is deleted.`)) {
                            remove.mutate(t.id);
                          }
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Sales out of storage */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Sold from storage</h3>
            <p className="text-xs text-muted-foreground">
              Pappu lorries dispatched with “Dispatch from Transfers” ticked. Lorries straight off the mill are not counted here.
            </p>
          </div>
          {sales.length > 0 && (
            <ExportButtons
              filename="Pappu_Sold_From_Storage"
              title="Pappu Sold from Storage"
              subtitle={`${sales.length} lorry(s)`}
              columns={SALE_COLUMNS}
              rows={sales}
            />
          )}
        </div>
        <div className="glass overflow-x-auto rounded-2xl">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Invoice</TableHead>
                <TableHead>Buyer</TableHead>
                <TableHead>Storage</TableHead>
                <TableHead>Lorry</TableHead>
                <TableHead className="text-right">From storage</TableHead>
                <TableHead className="text-right">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={7} className="h-24 text-center text-muted-foreground">Loading…</TableCell></TableRow>
              )}
              {!isLoading && sales.length === 0 && (
                <TableRow><TableCell colSpan={7} className="h-24 text-center text-muted-foreground">No Pappu sold from storage yet.</TableCell></TableRow>
              )}
              {sales.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="text-muted-foreground">{shortDate(s.dispatchDate)}</TableCell>
                  <TableCell className="font-mono text-xs font-semibold">
                    {s.invoiceNumber ?? <span className="font-sans font-normal text-muted-foreground">Uninvoiced</span>}
                  </TableCell>
                  <TableCell className="font-medium">{s.buyerName}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 font-medium text-amber-700 dark:text-amber-300">
                      {s.location}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{s.vehicleNumber ?? '-'}</TableCell>
                  <TableCell className="text-right">
                    <span className="font-mono font-semibold tabular-nums text-amber-700 dark:text-amber-400">−{mt(s.fromStorageKg)}</span>
                    {s.fromStorageKg < s.totalWeightKg && (
                      <span className="block text-[10px] font-normal text-muted-foreground">of {mt(s.totalWeightKg)} lorry</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Badge variant={s.status === 'DELIVERED' ? 'success' : 'soft'}>{titleCase(s.status)}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <datalist id="pappu-storages">
        {locationOptions.map((l) => <option key={l} value={l} />)}
      </datalist>

      {/* Record transfer */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Record Pappu Transfer</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="pt-date">Transfer date</Label>
                <Input id="pt-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pt-tonnes">Weight (tonnes)</Label>
                <Input id="pt-tonnes" type="number" step="0.001" min="0" value={tonnes} onChange={(e) => setTonnes(e.target.value)} placeholder="e.g. 35" />
                {weightKg > 0 && <p className="text-xs text-muted-foreground">{kg(weightKg)}</p>}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="pt-loc">Storage</Label>
                <Input id="pt-loc" list="pappu-storages" value={toLocation} onChange={(e) => setToLocation(e.target.value)} placeholder="Pick or type" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pt-lorry">Lorry number</Label>
                <Input id="pt-lorry" value={lorry} onChange={(e) => setLorry(e.target.value.toUpperCase())} placeholder="AP03AB1234" />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="pt-note">Note</Label>
              <Input id="pt-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
            </div>
            <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2 text-sm">
              <span className="text-muted-foreground">Hamali (₹{rate}/t, booked to the crew)</span>
              <span className="font-bold text-primary">{rupees(hamaliPreview)}</span>
            </div>
            <DialogFooter>
              <Button onClick={() => create.mutate()} disabled={!valid || create.isPending}>
                {create.isPending ? 'Saving…' : 'Save transfer'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit storage / lorry / note */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Edit Pappu Transfer</DialogTitle></DialogHeader>
          {editing && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {shortDate(editing.date)} · {mt(editing.weightKg)} · hamali {rupees(editing.hamaliAmount)}. To change the weight or date,
                delete this transfer and record it again.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="pe-loc">Storage</Label>
                  <Input id="pe-loc" list="pappu-storages" value={eLocation} onChange={(e) => setELocation(e.target.value)} placeholder="Pick or type" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pe-lorry">Lorry number</Label>
                  <Input id="pe-lorry" value={eLorry} onChange={(e) => setELorry(e.target.value.toUpperCase())} />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="pe-note">Note</Label>
                <Input id="pe-note" value={eNote} onChange={(e) => setENote(e.target.value)} />
              </div>
              <DialogFooter>
                <Button onClick={() => update.mutate()} disabled={!eLocation.trim() || update.isPending}>
                  {update.isPending ? 'Saving…' : 'Save'}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
