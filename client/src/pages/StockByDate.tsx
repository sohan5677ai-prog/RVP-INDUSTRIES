import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Search, Warehouse, IndianRupee, TrendingUp, Calculator, Factory, Scale, Wheat, ArrowDownRight, ArrowUpRight, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { api } from '@/lib/api';
import type { StockTransfer, FreightRate } from '@/lib/types';
import { rupees, shortDate, toTonnes } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface BlackSeedRow {
  purchaseId: string;
  date: string;
  rvpNetWeightKg: number;
  value: number;
  valueExclGstAndHamali: number;
  location: string;
}

interface BlackSeedStockResponse {
  rows: BlackSeedRow[];
  pappuSoldKg: number;
  pappuCommittedKg: number;
  totalMilledKg: number;
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
    g.recvValue += r.valueExclGstAndHamali;
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
  const [pappuPriceInput, setPappuPriceInput] = useState('');
  const [tonnageInput, setTonnageInput] = useState('');
  const [freightId, setFreightId] = useState('__none__');

  const { data, isLoading: loadingSeed } = useQuery({
    queryKey: ['black-seed-stock'],
    queryFn: () => api<BlackSeedStockResponse>('/inventory/black-seed'),
  });

  const { data: transfers, isLoading: loadingTransfers } = useQuery({
    queryKey: ['stock-transfers'],
    queryFn: () => api<StockTransfer[]>('/stock-transfers'),
  });

  const { data: freightRates } = useQuery({
    queryKey: ['freight-rates'],
    queryFn: () => api<FreightRate[]>('/settings/freight-rates'),
  });
  const selectedFreight = freightRates?.find((r) => r.id === freightId);
  const freightPerKg = selectedFreight ? Number(selectedFreight.ratePerTonne) / 1000 : 0;

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
    // Seed is drawn down by COMMITTED pappu sales (booked orders, max of ordered vs
    // dispatched): each kg consumes 1/0.6 kg of seed (60% out-turn). Mirrors Stock by Price.
    const seedConsumedByPappuKg = (data?.pappuCommittedKg ?? 0) / PAPPU_OUTTURN;

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
      const val = Number(t.seedCostMoved) + Number(t.interestCharge);
      if (existing) {
        existing.recvWeightKg += t.weightKg;
        existing.recvValue += val;
        existing.remWeightKg += t.weightKg;
        existing.remValue += val;
        existing.avgPrice = existing.recvWeightKg > 0 ? existing.recvValue / existing.recvWeightKg : 0;
      } else {
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

    // Step 4: Deplete FIFO by seed consumed for pappu sold (oldest dates first).
    depleteFifo(allLots, Math.round(seedConsumedByPappuKg));

    return allLots;
  }, [data, transfers]);

  // Overall remaining stock.
  const totalRemWeightKg = dateRows.reduce((s, r) => s + r.remWeightKg, 0);
  const totalRemValue = dateRows.reduce((s, r) => s + r.remValue, 0);
  const overallAvg = totalRemWeightKg > 0 ? totalRemValue / totalRemWeightKg : 0;

  // ─── Order planner maths (FIFO) ──────────────────────────────────────────
  const basePappuPrice = parseFloat(pappuPriceInput);
  const tonnage = parseFloat(tonnageInput);
  const hasPrice = Number.isFinite(basePappuPrice) && basePappuPrice > 0;
  const hasTonnage = Number.isFinite(tonnage) && tonnage > 0;
  const pappuPrice = Math.max(0, (hasPrice ? basePappuPrice : 0) - freightPerKg);

  const plan = useMemo(() => {
    if (!hasTonnage) return null; // FIFO strictly requires tonnage to know how deep into the stock queue to go
    if (dateRows.length === 0) return null;

    const askedPappuKg = tonnage * 1000;
    const blackRequiredKg = askedPappuKg / PAPPU_OUTTURN;

    let accumulatedKg = 0;
    let accumulatedValue = 0;
    let consumedLotsCount = 0;
    let earliestDate = '';
    let latestDate = '';

    // Consume from oldest to newest (dateRows is already sorted oldest-first)
    for (const row of dateRows) {
      if (row.remWeightKg <= 0) continue;
      
      const needed = blackRequiredKg - accumulatedKg;
      if (needed <= 1e-6) break;

      const take = Math.min(needed, row.remWeightKg);
      const takeValue = (take / row.remWeightKg) * row.remValue;

      accumulatedKg += take;
      accumulatedValue += takeValue;
      consumedLotsCount += 1;
      
      if (!earliestDate) earliestDate = row.date;
      latestDate = row.date;
    }

    const availableBlackKg = totalRemWeightKg;
    const producible = availableBlackKg * PAPPU_OUTTURN;
    
    const wacBlack = accumulatedKg > 0 ? accumulatedValue / accumulatedKg : 0;
    const wacPappuCost = wacBlack / PAPPU_OUTTURN;
    
    const diff = producible - askedPappuKg;
    const seedShortfallKg = Math.max(0, blackRequiredKg - availableBlackKg);
    const fulfillmentPct = askedPappuKg > 0 ? Math.min(100, ((accumulatedKg * PAPPU_OUTTURN) / askedPappuKg) * 100) : 100;
    const marginPerKg = hasPrice ? (pappuPrice - wacPappuCost) : 0;

    return {
      consumedLotsCount, earliestDate, latestDate,
      accumulatedKg,
      availableBlackKg,
      producible, wacBlack, wacPappuCost, askedPappuKg, blackRequiredKg,
      seedShortfallKg, diff, fulfillmentPct, marginPerKg,
    };
  }, [dateRows, totalRemWeightKg, pappuPrice, tonnage, hasPrice, hasTonnage]);

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
          Transferred stock appears at its transfer date with capitalised costs. Valuation excludes GST.
        </p>
      </div>

      {/* ─── Order Planner (FIFO) ──────────────────────────────────────────────── */}
      <Card className="border-l-4 border-l-primary shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Calculator className="h-4 w-4 text-primary" /> Order Planner (FIFO)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl">
            <div className="space-y-1">
              <Label htmlFor="tonnage" className="text-xs text-muted-foreground">Tonnage asked (MT)</Label>
              <Input
                id="tonnage"
                type="number"
                min="0"
                step="0.5"
                value={tonnageInput}
                onChange={(e) => setTonnageInput(e.target.value)}
                placeholder="e.g. 30 (Required)"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pappu-price" className="text-xs text-muted-foreground">Pappu price asked (₹/kg)</Label>
              <Input
                id="pappu-price"
                type="number"
                min="0"
                step="0.5"
                value={pappuPriceInput}
                onChange={(e) => setPappuPriceInput(e.target.value)}
                placeholder="e.g. 42 (Optional for margin)"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="freight" className="text-xs text-muted-foreground">Freight</Label>
              <Select value={freightId} onValueChange={setFreightId}>
                <SelectTrigger id="freight">
                  <SelectValue placeholder="No freight" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No freight</SelectItem>
                  {freightRates?.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.destination} — {rupees(r.ratePerTonne)}/t
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {hasPrice && freightPerKg > 0 && (
            <p className="text-xs text-muted-foreground">
              Pappu ₹{basePappuPrice.toFixed(2)} − freight {rupees(freightPerKg)}/kg ({rupees(selectedFreight!.ratePerTonne)}/t to {selectedFreight!.destination}) ={' '}
              <span className="font-semibold text-foreground">{rupees(pappuPrice)}/kg net</span>
            </p>
          )}

          {!hasTonnage && (
            <p className="text-sm text-muted-foreground">Enter the tonnage asked to see which lots will be consumed.</p>
          )}

          {plan && (
            <div className="space-y-4">
              {/* Mapping line */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                <span>{tonnage.toFixed(2)} MT Order</span>
                <ArrowDownRight className="h-4 w-4" />
                <span>draws from the oldest available stock:</span>
                <Badge variant="outline" className="bg-primary/5 text-primary border-primary/20 font-bold">
                  {plan.consumedLotsCount} date lot{plan.consumedLotsCount === 1 ? '' : 's'}
                </Badge>
                <span>
                  · {plan.earliestDate && plan.latestDate ? `from ${shortDate(plan.earliestDate)} to ${shortDate(plan.latestDate)}` : ''}
                  {plan.accumulatedKg > 0 && <> · avg cost {rupees(plan.wacPappuCost)}/kg pappu</>}
                </span>
              </div>

              {/* Result tiles */}
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                <div className="rounded-lg border p-3">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                    <Wheat className="h-3 w-3" /> Producible Pappu
                  </div>
                  <div className="text-xl font-bold text-sky-600 mt-1">{toTonnes(plan.producible).toFixed(2)} MT</div>
                  <div className="text-[10px] text-muted-foreground">from {toTonnes(plan.availableBlackKg).toFixed(2)} MT total remaining seed</div>
                </div>

                <div className="rounded-lg border p-3">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                    <Scale className="h-3 w-3" /> Asked
                  </div>
                  <div className="text-xl font-bold mt-1">{tonnage.toFixed(2)} MT</div>
                  <div className="text-[10px] text-muted-foreground">needs {toTonnes(plan.blackRequiredKg).toFixed(2)} MT seed</div>
                </div>

                {/* Shortage / Excess */}
                {plan.diff < 0 ? (
                  <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-rose-600 flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3" /> Shortage
                    </div>
                    <div className="text-xl font-bold text-rose-600 mt-1">{toTonnes(Math.abs(plan.diff)).toFixed(2)} MT</div>
                    <div className="text-[10px] text-rose-600/80">short of the {tonnage.toFixed(2)} MT order</div>
                  </div>
                ) : (
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-emerald-600 flex items-center gap-1">
                      <CheckCircle2 className="h-3 w-3" /> Excess
                    </div>
                    <div className="text-xl font-bold text-emerald-600 mt-1">{toTonnes(plan.diff).toFixed(2)} MT</div>
                    <div className="text-[10px] text-emerald-600/80">spare pappu after the order</div>
                  </div>
                )}

                {/* Black seed needed */}
                <div className={`rounded-lg border p-3 ${plan.seedShortfallKg > 0 ? 'border-rose-200 bg-rose-50' : ''}`}>
                  <div className={`text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1 ${plan.seedShortfallKg > 0 ? 'text-rose-600' : 'text-muted-foreground'}`}>
                    <Factory className="h-3 w-3" /> Seed Needed
                  </div>
                  <div className={`text-xl font-bold mt-1 ${plan.seedShortfallKg > 0 ? 'text-rose-600' : 'text-muted-foreground'}`}>
                    {plan.seedShortfallKg > 0 ? `${toTonnes(plan.seedShortfallKg).toFixed(2)} MT` : '0.00 MT'}
                  </div>
                  <div className={`text-[10px] ${plan.seedShortfallKg > 0 ? 'text-rose-600/80' : 'text-muted-foreground'}`}>
                    {plan.seedShortfallKg > 0 ? 'extra black seed to source' : 'order fully covered'}
                  </div>
                </div>

                {/* Margin */}
                <div className="rounded-lg border p-3">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                    {plan.marginPerKg >= 0 ? <ArrowUpRight className="h-3 w-3 text-emerald-500" /> : <ArrowDownRight className="h-3 w-3 text-rose-500" />} Margin
                  </div>
                  <div className={`text-xl font-bold mt-1 ${!hasPrice ? 'text-muted-foreground' : plan.marginPerKg >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                    {!hasPrice ? '—' : `${rupees(plan.marginPerKg)}/kg`}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {hasPrice ? `sell − avg cost ${rupees(plan.wacPappuCost)}/kg` : 'enter price'}
                  </div>
                </div>
              </div>

              {/* Fulfillment */}
              <div className="space-y-2 max-w-xl">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Fulfilment from stock</span>
                  <span className="font-semibold">{plan.fulfillmentPct.toFixed(0)}%</span>
                </div>
                <div className="h-2 w-full bg-muted rounded-full overflow-hidden">
                  <div
                    className={`h-full ${plan.seedShortfallKg > 0 ? 'bg-rose-500' : 'bg-emerald-500'}`}
                    style={{ width: `${plan.fulfillmentPct}%` }}
                  />
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

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
            <p className="text-[10px] text-muted-foreground mt-1">Seed cost + freight (if BASE price, excl. GST)</p>
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
