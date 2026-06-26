import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, Loader2, Warehouse, TrendingUp, IndianRupee, Package, Landmark } from 'lucide-react';
import { api } from '@/lib/api';
import type { StockTransfer, LoansResponse } from '@/lib/types';
import { rupees, shortDate, toTonnes } from '@/lib/format';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';

type LocationType = 'At process' | 'Rampalli' | 'Murgan' | 'Multi';

// Same shape the /inventory/black-seed endpoint returns (per-purchase row).
interface BlackSeedRow {
  purchaseId: string;
  date: string;       // arrival date ISO
  rvpNetWeightKg: number;
  value: number;
  valueExclGstAndHamali: number;
  location: string;   // loading location
}

interface BlackSeedStockResponse {
  rows: BlackSeedRow[];
  pappuSoldKg: number;
  poTonnageKg: number;
}

// Standard milling out-turn: 60% of raw black seed yields pappu.
const PAPPU_OUTTURN = 0.6;

const locations: LocationType[] = ['At process', 'Rampalli', 'Murgan', 'Multi'];

// A single date-wise lot at a particular location (after FIFO depletion).
interface DateLot {
  date: string;      // YYYY-MM-DD
  lorries: number;
  recvWeightKg: number;
  recvValue: number;
  avgPrice: number;  // recvValue / recvWeightKg (cost per kg at the time of receipt)
  remWeightKg: number;
  remValue: number;
  isTransferredIn?: boolean; // lot arrived via transfer (not original purchase)
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Group purchase rows into date-wise lots and sort oldest-first. */
function buildDateLots(rows: BlackSeedRow[]): DateLot[] {
  const groups = new Map<string, DateLot>();
  for (const r of rows) {
    const d = r.date.slice(0, 10);
    const g = groups.get(d) ?? {
      date: d, lorries: 0, recvWeightKg: 0, recvValue: 0, avgPrice: 0,
      remWeightKg: 0, remValue: 0,
    };
    g.lorries += 1;
    g.recvWeightKg += r.rvpNetWeightKg;
    g.recvValue += r.valueExclGstAndHamali;
    groups.set(d, g);
  }
  const ordered = [...groups.values()].sort((a, b) => a.date.localeCompare(b.date));
  // Set initial avg price and rem = recv (before depletion).
  for (const g of ordered) {
    g.avgPrice = g.recvWeightKg > 0 ? g.recvValue / g.recvWeightKg : 0;
    g.remWeightKg = g.recvWeightKg;
    g.remValue = g.recvValue;
  }
  return ordered;
}

/**
 * Deplete `consumeKg` from the ordered lots using FIFO (oldest first).
 * Value is removed proportionally so the lot's avg price stays stable.
 * Mutates the lots in place.
 */
function depleteFifo(lots: DateLot[], consumeKg: number): void {
  let remaining = consumeKg;
  for (const g of lots) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, g.remWeightKg);
    const takeValue = g.remWeightKg > 0
      ? Math.round(g.remValue * (take / g.remWeightKg) * 100) / 100
      : 0;
    g.remWeightKg -= take;
    g.remValue = Math.max(0, g.remValue - takeValue);
    // If fully depleted, zero out exactly to avoid floating point dust.
    if (g.remWeightKg <= 0) {
      g.remWeightKg = 0;
      g.remValue = 0;
    }
    remaining -= take;
  }
}

// ─── Component ─────────────────────────────────────────────────────────────

export default function StockLocation() {
  const [selectedLoc, setSelectedLoc] = useState<'All' | LocationType>('All');
  const [searchQuery, setSearchQuery] = useState('');
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

  const { data: loanData, isLoading: loadingLoans } = useQuery({
    queryKey: ['loans'],
    queryFn: () => api<LoansResponse>('/loans'),
  });

  // Build per-location FIFO lots.
  const locationData = useMemo(() => {
    const allRows = data?.rows ?? [];
    const allTransfers = transfers ?? [];
    const pappuSoldKg = data?.pappuSoldKg ?? 0;

    // Step 1: Group purchase rows by location, then build date-wise lots.
    const locLots: Record<string, DateLot[]> = {};
    for (const loc of locations) {
      const locRows = allRows.filter((r) => (r.location || 'At process') === loc);
      locLots[loc] = buildDateLots(locRows);
    }

    // Step 2: Deplete storage locations FIFO by transfers OUT.
    // Sort transfers by date (oldest first) for proper FIFO ordering.
    const sortedTransfers = [...allTransfers].sort(
      (a, b) => a.transferDate.localeCompare(b.transferDate)
    );

    // Track transfer-in lots for "At process" (or any toLocation).
    const transferInLots: { toLocation: string; date: string; weightKg: number; value: number }[] = [];

    for (const t of sortedTransfers) {
      const fromLoc = t.fromLocation;
      const lots = locLots[fromLoc];
      if (!lots) continue;
      // Deplete from source (FIFO).
      depleteFifo(lots, t.weightKg);
      // Record as a transfer-in lot at the destination.
      transferInLots.push({
        toLocation: t.toLocation,
        date: t.transferDate.slice(0, 10),
        weightKg: t.weightKg,
        value: Number(t.seedCostMoved) + Number(t.interestCharge),
      });
    }

    // Step 3: Add transfer-in lots to destination locations.
    for (const tin of transferInLots) {
      const destLoc = tin.toLocation;
      if (!locLots[destLoc]) locLots[destLoc] = [];
      const lots = locLots[destLoc];
      // Merge into existing transfer-in lot for the same date, or create new.
      const existing = lots.find((l) => l.date === tin.date && l.isTransferredIn);
      if (existing) {
        existing.recvWeightKg += tin.weightKg;
        existing.recvValue += tin.value;
        existing.remWeightKg += tin.weightKg;
        existing.remValue += tin.value;
        existing.avgPrice = existing.recvWeightKg > 0 ? existing.recvValue / existing.recvWeightKg : 0;
      } else {
        const avgP = tin.weightKg > 0 ? tin.value / tin.weightKg : 0;
        lots.push({
          date: tin.date,
          lorries: 0, // transfers aren't lorry arrivals
          recvWeightKg: tin.weightKg,
          recvValue: tin.value,
          avgPrice: avgP,
          remWeightKg: tin.weightKg,
          remValue: tin.value,
          isTransferredIn: true,
        });
      }
      // Re-sort after insertion so FIFO order is maintained.
      lots.sort((a, b) => a.date.localeCompare(b.date));
    }

    // Step 4: Deplete "At process" FIFO by pappu sold.
    const processLots = locLots['At process'] ?? [];
    const consumeKg = Math.round(pappuSoldKg / PAPPU_OUTTURN);
    depleteFifo(processLots, consumeKg);

    return locLots;
  }, [data, transfers]);

  // Compute metrics for a single location or all.
  const getMetrics = (loc: 'All' | LocationType) => {
    const locs = loc === 'All' ? locations : [loc];
    let totalRemWeightKg = 0;
    let totalRemValue = 0;
    let totalRecvWeightKg = 0;
    let totalRecvValue = 0;
    let allLots: DateLot[] = [];

    for (const l of locs) {
      const lots = locationData[l] ?? [];
      for (const lot of lots) {
        totalRemWeightKg += lot.remWeightKg;
        totalRemValue += lot.remValue;
        totalRecvWeightKg += lot.recvWeightKg;
        totalRecvValue += lot.recvValue;
      }
      allLots = allLots.concat(lots);
    }

    let totalOutstandingLoan = 0;
    if (loanData?.loans) {
      for (const loan of loanData.loans) {
        if (loan.status === 'OPEN' && loan.location) {
          if (loc === 'All' || loan.location === loc) {
            totalOutstandingLoan += loan.outstanding;
          }
        }
      }
    }

    const overallAvg = totalRemWeightKg > 0 ? totalRemValue / totalRemWeightKg : 0;
    const pappuToConvertKg = totalRemWeightKg * PAPPU_OUTTURN;
    return { totalRemWeightKg, totalRemValue, totalRecvWeightKg, totalRecvValue, overallAvg, pappuToConvertKg, allLots, totalOutstandingLoan };
  };

  const metrics = getMetrics(selectedLoc);

  // Filter lots for the detail table.
  const q = searchQuery.trim().toLowerCase();
  const visibleLots = metrics.allLots.filter((r) => {
    if (fromDate && r.date < fromDate) return false;
    if (toDate && r.date > toDate) return false;
    if (q && !shortDate(r.date).toLowerCase().includes(q) && !r.date.includes(q)) return false;
    return true;
  });

  const isLoading = loadingSeed || loadingTransfers || loadingLoans;

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
        <h1 className="text-2xl font-bold">Stock by Location (FIFO)</h1>
        <p className="text-muted-foreground">
          Location-wise black-seed lots on a first-in-first-out basis. Transfers out of storage
          deplete the oldest lots first; pappu sold depletes the oldest stock at the process —
          so the weighted-average price reflects the pooled stock still on hand at each location. Valuation excludes GST.
        </p>
      </div>

      {/* KPI tiles */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Stock on Hand</CardTitle>
            <Warehouse className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{toTonnes(metrics.totalRemWeightKg).toFixed(2)} MT</div>
            <p className="text-[10px] text-muted-foreground mt-1">
              After FIFO depletion · {selectedLoc === 'All' ? 'All locations' : selectedLoc}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Stock Valuation</CardTitle>
            <IndianRupee className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-emerald-600">{rupees(metrics.totalRemValue)}</div>
            <p className="text-[10px] text-muted-foreground mt-1">
              Seed cost + freight (if BASE price, excl. GST)
              {metrics.totalRecvValue !== metrics.totalRemValue && (
                <span className="block">of {rupees(metrics.totalRecvValue)} total received</span>
              )}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Weighted Avg Price</CardTitle>
            <TrendingUp className="h-4 w-4 text-rose-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-rose-600">{rupees(metrics.overallAvg)}/kg</div>
            <p className="text-[10px] text-muted-foreground mt-1">Across remaining stock</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Pappu to be Converted</CardTitle>
            <Package className="h-4 w-4 text-sky-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-sky-600">{toTonnes(metrics.pappuToConvertKg).toFixed(2)} MT</div>
            <p className="text-[10px] text-muted-foreground mt-1">60% out-turn of stock on hand</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Outstanding Loans</CardTitle>
            <Landmark className="h-4 w-4 text-violet-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-violet-600">{rupees(metrics.totalOutstandingLoan)}</div>
            <p className="text-[10px] text-muted-foreground mt-1">Principal owed to bank against stock</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="location" className="text-xs text-muted-foreground">Location</Label>
          <Select value={selectedLoc} onValueChange={(v) => setSelectedLoc(v as 'All' | LocationType)}>
            <SelectTrigger id="location" className="w-56 bg-card">
              <SelectValue placeholder="Select location" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="All">All locations</SelectItem>
              {locations.map((loc) => (
                <SelectItem key={loc} value={loc}>{loc}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1 flex-1 min-w-52">
          <Label htmlFor="search" className="text-xs text-muted-foreground">Search date</Label>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              id="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
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
        {(searchQuery || fromDate || toDate) && (
          <button
            type="button"
            onClick={() => { setSearchQuery(''); setFromDate(''); setToDate(''); }}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline pb-2.5"
          >
            Clear
          </button>
        )}
      </div>

      {/* Per-location FIFO breakdown tiles (when "All" is selected) */}
      {selectedLoc === 'All' && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {locations.map((loc) => {
            const m = getMetrics(loc);
            return (
              <button
                key={loc}
                type="button"
                onClick={() => setSelectedLoc(loc)}
                className="rounded-lg border bg-card p-3 text-left hover:border-primary/50 transition-colors"
              >
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{loc}</div>
                <div className="text-lg font-bold text-primary mt-1">{toTonnes(m.totalRemWeightKg).toFixed(2)} MT</div>
                <div className="text-xs text-emerald-600 font-medium">{rupees(m.totalRemValue)} stock</div>
                <div className="text-xs text-violet-600 font-medium">{rupees(m.totalOutstandingLoan)} loan</div>
                <div className="text-xs text-muted-foreground">
                  {rupees(m.overallAvg)}/kg avg
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Date-wise FIFO ledger */}
      <div className="rounded-lg border bg-card overflow-x-auto">
        <div className="px-5 py-4 border-b bg-muted/10">
          <span className="font-semibold text-sm">
            FIFO Ledger: <span className="text-primary font-bold">{selectedLoc === 'All' ? 'All locations' : selectedLoc}</span>
          </span>
          <p className="text-xs text-muted-foreground mt-0.5">
            {selectedLoc === 'At process' || selectedLoc === 'All'
              ? 'Oldest stock consumed first by pappu sold and transfers'
              : 'Oldest stock consumed first by transfers to process'}
          </p>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              {selectedLoc === 'All' && <TableHead>Source</TableHead>}
              <TableHead className="text-right">Lorries</TableHead>
              <TableHead className="text-right">Received MT</TableHead>
              <TableHead className="text-right">Remaining MT</TableHead>
              <TableHead className="text-right">Remaining Valuation</TableHead>
              <TableHead className="text-right">Avg Price</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleLots.length === 0 && (
              <TableRow>
                <TableCell colSpan={selectedLoc === 'All' ? 7 : 6} className="text-center text-muted-foreground py-8">
                  {(metrics.allLots.length === 0)
                    ? 'No black seed in stock at this location.'
                    : 'No dates match the filter.'}
                </TableCell>
              </TableRow>
            )}
            {visibleLots.map((r, idx) => {
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
                  {selectedLoc === 'All' && (
                    <TableCell className="text-sm text-muted-foreground">—</TableCell>
                  )}
                  <TableCell className="text-right font-medium">
                    {r.lorries > 0 ? r.lorries : '—'}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {toTonnes(r.recvWeightKg).toFixed(2)} MT
                  </TableCell>
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
