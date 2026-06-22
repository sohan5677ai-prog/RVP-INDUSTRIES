import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Search, Warehouse, IndianRupee, TrendingUp } from 'lucide-react';
import { api } from '@/lib/api';
import type { StockTransfer } from '@/lib/types';
import { rupees, shortDate, toTonnes } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface BlackSeedRow {
  purchaseId: string;
  date: string;
  rvpNetWeightKg: number;
  value: number;
  location: string;
}

interface BlackSeedStockResponse {
  rows: BlackSeedRow[];
  pappuSoldKg: number;
  poTonnageKg: number;
}

// Pooled model: pappu is 60% of black seed, so each kg of pappu sold consumes
// (1 / 0.60) kg of black seed from the pool — drawn oldest-date-first (FIFO).
const PAPPU_OUTTURN = 0.6;

const STORAGE_LOCATIONS = ['Rampalli', 'Murgan', 'Multi'];

interface DateRow {
  date: string; // YYYY-MM-DD
  lorries: number;
  recvWeightKg: number;
  recvValue: number;
  avgPrice: number; // recvValue / recvWeightKg
  remWeightKg: number; // after FIFO depletion
  remValue: number;
  isTransferredIn?: boolean; // lot arrived via a stock transfer
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Group rows into date-wise lots sorted oldest-first. */
function buildDateLots(rows: BlackSeedRow[]): DateRow[] {
  const groups = new Map<string, DateRow>();
  for (const r of rows) {
    const d = r.date.slice(0, 10);
    const g = groups.get(d) ?? {
      date: d, lorries: 0, recvWeightKg: 0, recvValue: 0, avgPrice: 0,
      remWeightKg: 0, remValue: 0,
    };
    g.lorries += 1;
    g.recvWeightKg += r.rvpNetWeightKg;
    g.recvValue += r.value;
    groups.set(d, g);
  }
  const ordered = [...groups.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const g of ordered) {
    g.avgPrice = g.recvWeightKg > 0 ? g.recvValue / g.recvWeightKg : 0;
    g.remWeightKg = g.recvWeightKg;
    g.remValue = g.recvValue;
  }
  return ordered;
}

/** Deplete `consumeKg` from the ordered lots FIFO. Mutates in place. */
function depleteFifo(lots: DateRow[], consumeKg: number): void {
  let remaining = consumeKg;
  for (const g of lots) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, g.remWeightKg);
    const takeValue = g.remWeightKg > 0
      ? Math.round(g.remValue * (take / g.remWeightKg) * 100) / 100
      : 0;
    g.remWeightKg -= take;
    g.remValue = Math.max(0, g.remValue - takeValue);
    if (g.remWeightKg <= 0) { g.remWeightKg = 0; g.remValue = 0; }
    remaining -= take;
  }
}

// ─── Component ─────────────────────────────────────────────────────────────

export default function StockByDate() {
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const { data, isLoading: loadingSeed } = useQuery({
    queryKey: ['black-seed-stock'],
    queryFn: () => api<BlackSeedStockResponse>('/inventory/black-seed'),
  });

  const { data: transfers, isLoading: loadingTransfers } = useQuery({
    queryKey: ['stock-transfers'],
    queryFn: () => api<StockTransfer[]>('/stock-transfers'),
  });

  // Build date-wise lots with full transfer visibility.
  //
  // The pipeline mirrors Stock by Location:
  // 1. Group purchases by location → build per-location date lots
  // 2. Deplete storage locations FIFO by transfers OUT
  // 3. Add transfer-in lots at the transfer date (with capitalised value)
  // 4. Merge all lots into a single date-sorted list
  // 5. Deplete FIFO by pappu sold
  //
  // This makes transferred stock appear as its own date row.
  const dateRows = useMemo<DateRow[]>(() => {
    const rows = data?.rows ?? [];
    const allTransfers = transfers ?? [];
    const pappuSoldKg = data?.pappuSoldKg ?? 0;

    // Step 1: Group purchases by location, build per-location date lots.
    const processRows = rows.filter((r) => !STORAGE_LOCATIONS.includes(r.location || 'At process'));
    const storageLots: Record<string, DateRow[]> = {};
    for (const loc of STORAGE_LOCATIONS) {
      const locRows = rows.filter((r) => (r.location || 'At process') === loc);
      storageLots[loc] = buildDateLots(locRows);
    }
    const processLots = buildDateLots(processRows);

    // Step 2: Deplete storage locations FIFO by transfers OUT.
    const sortedTransfers = [...allTransfers].sort(
      (a, b) => a.transferDate.localeCompare(b.transferDate)
    );

    const transferInLots: DateRow[] = [];

    for (const t of sortedTransfers) {
      const lots = storageLots[t.fromLocation];
      if (!lots) continue;
      depleteFifo(lots, t.weightKg);

      // Create a transfer-in lot at the transfer date with capitalised value.
      const d = t.transferDate.slice(0, 10);
      const existing = transferInLots.find((l) => l.date === d);
      if (existing) {
        existing.recvWeightKg += t.weightKg;
        existing.recvValue += Number(t.movedValue);
        existing.remWeightKg += t.weightKg;
        existing.remValue += Number(t.movedValue);
        existing.avgPrice = existing.recvWeightKg > 0 ? existing.recvValue / existing.recvWeightKg : 0;
      } else {
        const val = Number(t.movedValue);
        transferInLots.push({
          date: d,
          lorries: 0,
          recvWeightKg: t.weightKg,
          recvValue: val,
          avgPrice: t.weightKg > 0 ? val / t.weightKg : 0,
          remWeightKg: t.weightKg,
          remValue: val,
          isTransferredIn: true,
        });
      }
    }

    // Step 3: Merge all lots — remaining storage lots + process lots + transfer-in lots.
    const allLots: DateRow[] = [
      ...processLots,
      ...transferInLots,
    ];
    // Include storage lots that still have remaining stock (not fully transferred).
    for (const loc of STORAGE_LOCATIONS) {
      for (const lot of storageLots[loc]) {
        if (lot.remWeightKg > 0) {
          // Adjust recvWeightKg/recvValue to match what's still at storage.
          allLots.push({
            ...lot,
            recvWeightKg: lot.remWeightKg,
            recvValue: lot.remValue,
            avgPrice: lot.avgPrice,
          });
        }
      }
    }

    // Sort all lots by date (oldest first) for FIFO.
    allLots.sort((a, b) => a.date.localeCompare(b.date));

    // Step 4: Deplete by pappu sold FIFO.
    const consumeKg = Math.round(pappuSoldKg / PAPPU_OUTTURN);
    depleteFifo(allLots, consumeKg);

    return allLots;
  }, [data, transfers]);

  // Overall remaining stock.
  const totalRemWeightKg = dateRows.reduce((s, r) => s + r.remWeightKg, 0);
  const totalRemValue = dateRows.reduce((s, r) => s + r.remValue, 0);
  const overallAvg = totalRemWeightKg > 0 ? totalRemValue / totalRemWeightKg : 0;

  const isLoading = loadingSeed || loadingTransfers;

  const q = search.trim().toLowerCase();
  const visible = dateRows.filter((r) => {
    if (fromDate && r.date < fromDate) return false;
    if (toDate && r.date > toDate) return false;
    if (q && !shortDate(r.date).toLowerCase().includes(q) && !r.date.includes(q)) return false;
    return true;
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Stock by Date (FIFO)</h1>
        <p className="text-muted-foreground">
          Date-wise black-seed lots on a first-in-first-out basis. As pappu is sold, the equivalent black seed is
          drawn from the oldest dates first — so the running weighted-average price reflects the pooled stock still on hand.
          Transferred stock appears at its transfer date with capitalised costs.
        </p>
      </div>

      {/* Headline: overall remaining stock + weighted average */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Stock on Hand</CardTitle>
            <Warehouse className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{toTonnes(totalRemWeightKg).toFixed(2)} MT</div>
            <p className="text-[10px] text-muted-foreground mt-1">After FIFO depletion by pappu sold</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Stock Valuation</CardTitle>
            <IndianRupee className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-emerald-600">{rupees(totalRemValue)}</div>
            <p className="text-[10px] text-muted-foreground mt-1">Seed cost + capitalised charges + transfer costs</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Weighted Avg Price</CardTitle>
            <TrendingUp className="h-4 w-4 text-rose-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-rose-600">{rupees(overallAvg)}/kg</div>
            <p className="text-[10px] text-muted-foreground mt-1">Across all remaining stock</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1 flex-1 min-w-52">
          <Label htmlFor="search" className="text-xs text-muted-foreground">Search date</Label>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              id="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="e.g. Jun, 19, 2026"
              className="pl-8"
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="from-date" className="text-xs text-muted-foreground">From</Label>
          <Input id="from-date" type="date" value={fromDate} max={toDate || undefined} onChange={(e) => setFromDate(e.target.value)} className="w-40" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="to-date" className="text-xs text-muted-foreground">To</Label>
          <Input id="to-date" type="date" value={toDate} min={fromDate || undefined} onChange={(e) => setToDate(e.target.value)} className="w-40" />
        </div>
        {(search || fromDate || toDate) && (
          <button
            type="button"
            onClick={() => { setSearch(''); setFromDate(''); setToDate(''); }}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline pb-2.5"
          >
            Clear
          </button>
        )}
      </div>

      {/* Date-wise FIFO ledger */}
      <div className="rounded-lg border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead className="text-right">Total Lorries</TableHead>
              <TableHead className="text-right">Total MT</TableHead>
              <TableHead className="text-right">Stock Valuation</TableHead>
              <TableHead className="text-right">Weighted Avg Price</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                  {dateRows.length === 0
                    ? 'No black seed in stock yet. Approve purchases on the Verification page to add stock.'
                    : 'No dates match the filter.'}
                </TableCell>
              </TableRow>
            )}
            {visible.map((r, idx) => {
              const depleted = r.remWeightKg === 0;
              const partial = !depleted && r.remWeightKg < r.recvWeightKg;
              return (
                <TableRow key={`${r.date}-${idx}`} className={depleted ? 'opacity-50' : undefined}>
                  <TableCell>
                    {shortDate(r.date)}
                    {r.isTransferredIn && <Badge variant="outline" className="ml-2 text-[10px] text-blue-600">Transferred in</Badge>}
                    {depleted && <Badge variant="outline" className="ml-2 text-[10px]">Sold through</Badge>}
                    {partial && <Badge variant="outline" className="ml-2 text-[10px] text-amber-600">Partial</Badge>}
                  </TableCell>
                  <TableCell className="text-right font-medium">{r.lorries > 0 ? r.lorries : '—'}</TableCell>
                  <TableCell className="text-right font-semibold">
                    {toTonnes(r.remWeightKg).toFixed(2)} MT
                    {r.remWeightKg !== r.recvWeightKg && (
                      <span className="block text-[10px] text-muted-foreground font-normal">of {toTonnes(r.recvWeightKg).toFixed(2)} received</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-semibold text-emerald-600">
                    {rupees(r.remValue)}
                    {r.remValue !== r.recvValue && r.recvValue > 0 && (
                      <span className="block text-[10px] text-muted-foreground font-normal">of {rupees(r.recvValue)} received</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-medium">{rupees(r.avgPrice)}/kg</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
