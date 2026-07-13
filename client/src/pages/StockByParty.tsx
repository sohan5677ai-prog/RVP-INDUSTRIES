import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, Loader2, Users, ArrowUpRight, ArrowDownRight, Archive, ChevronRight, ChevronDown, Target, ShoppingCart, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { api } from '@/lib/api';
import { kg, rupees, toTonnes } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';

type BlendStatus = 'ok' | 'already' | 'infeasible' | 'nostock';

/**
 * How much black seed (kg) to buy at `buyPrice` to pull a stock of `currentKg`
 * sitting at `currentAvg` ₹/kg down to a `target` ₹/kg weighted average.
 *
 * Solves (currentKg·currentAvg + x·buyPrice) / (currentKg + x) = target  for x:
 *   x = currentKg · (currentAvg − target) / (target − buyPrice)
 *
 * Only feasible when buyPrice < target < currentAvg - you can't dilute an
 * average below the price you buy at, and there's nothing to do once the
 * target is already at/above the current average.
 */
function buyKgToReachTarget(currentKg: number, currentAvg: number, target: number, buyPrice: number): { kg: number; status: BlendStatus } {
  if (!(currentKg > 0) || !(currentAvg > 0)) return { kg: 0, status: 'nostock' };
  if (target >= currentAvg) return { kg: 0, status: 'already' };
  if (buyPrice >= target) return { kg: 0, status: 'infeasible' };
  return { kg: currentKg * (currentAvg - target) / (target - buyPrice), status: 'ok' };
}

interface StockInDetail {
  id: string;
  arrivalDate: string;
  lorryNumber: string;
  invoiceNumber: string;
  purchasedWeightKg: number;
  milledWeightKg: number;
  netWeightKg: number;
  poNumber: string | null;
  value: number;
}

interface PricePool {
  pricePerKg: number;
  totalPurchasedKg: number;
  totalMilledKg: number;
  netStockKg: number;
  purchasedValue: number;
  value: number;
  stockIns: StockInDetail[];
}

interface PartyStock {
  partyId: string;
  partyName: string;
  phone: string;
  address: string;
  state: string;
  totalPurchasedKg: number;
  totalMilledKg: number;
  netStockKg: number;
  totalValuation: number;
  weightedAveragePrice: number;
  pricePools: PricePool[];
}

export default function StockByParty() {
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedParties, setExpandedParties] = useState<Set<string>>(new Set());
  const [targetInput, setTargetInput] = useState('');
  const [buyPriceInput, setBuyPriceInput] = useState('');

  const { data: partyStocks, isLoading } = useQuery<PartyStock[]>({
    queryKey: ['party-stocks'],
    queryFn: () => api<PartyStock[]>('/inventory/by-party'),
  });

  const totalRemaining = partyStocks?.reduce((sum, p) => sum + p.netStockKg, 0) ?? 0;
  const totalValuation = partyStocks?.reduce((sum, p) => sum + (p.totalValuation ?? 0), 0) ?? 0;
  const overallWac = totalRemaining > 0 ? totalValuation / totalRemaining : 0;

  const sortedPartiesByStock = [...(partyStocks ?? [])].sort((a, b) => b.netStockKg - a.netStockKg);
  const topSupplier = sortedPartiesByStock[0];
  const supplierConcentrationPct = totalRemaining > 0 && topSupplier 
    ? (topSupplier.netStockKg / totalRemaining) * 100 
    : 0;

  const overallPricePoolsMap = new Map<number, number>();
  for (const party of partyStocks ?? []) {
    for (const pool of party.pricePools ?? []) {
      if (pool.netStockKg > 0) {
        overallPricePoolsMap.set(
          pool.pricePerKg,
          (overallPricePoolsMap.get(pool.pricePerKg) ?? 0) + pool.netStockKg
        );
      }
    }
  }
  const overallPricePools = [...overallPricePoolsMap.entries()]
    .map(([price, weight]) => ({ price, weight, pct: totalRemaining > 0 ? (weight / totalRemaining) * 100 : 0 }))
    .sort((a, b) => b.price - a.price);

  // ─── Blend-to-Target planner ───────────────────────────────────────────────
  // Smart default for the buy price = the cheapest band we currently hold, since
  // that's the most realistic price at which fresh seed could pull the avg down.
  const lowestBandPrice = overallPricePools.length ? overallPricePools[overallPricePools.length - 1].price : 0;
  const targetAvg = parseFloat(targetInput);
  const hasTarget = Number.isFinite(targetAvg) && targetAvg > 0;
  const buyPrice = buyPriceInput.trim() ? parseFloat(buyPriceInput) : lowestBandPrice;
  const hasBuy = Number.isFinite(buyPrice) && buyPrice > 0;
  const planActive = hasTarget && hasBuy;

  const wholeResult = planActive ? buyKgToReachTarget(totalRemaining, overallWac, targetAvg, buyPrice) : null;
  const newTotalKg = wholeResult ? totalRemaining + wholeResult.kg : 0;
  const newValuation = wholeResult ? totalValuation + wholeResult.kg * buyPrice : 0;

  function toggleParty(partyId: string) {
    setExpandedParties((prev) => {
      const next = new Set(prev);
      if (next.has(partyId)) next.delete(partyId);
      else next.add(partyId);
      return next;
    });
  }

  const filteredPartyStocks = partyStocks?.filter((p) => {
    const term = searchQuery.toLowerCase();
    return (
      p.partyName.toLowerCase().includes(term) ||
      p.address.toLowerCase().includes(term) ||
      p.state.toLowerCase().includes(term)
    );
  }) ?? [];

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
        <h1 className="text-2xl font-bold">Stock by Party</h1>
        <p className="text-muted-foreground">
          Track raw black seed stock balances credited to individual suppliers with price pooling
        </p>
      </div>

      {/* Advanced Business Intelligence Overview */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="border-l-4 border-l-primary shadow-sm hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Raw Stock</CardTitle>
            <Archive className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-extrabold text-primary">{toTonnes(totalRemaining).toFixed(2)} MT</div>
            <p className="text-[10px] text-muted-foreground mt-1">({kg(totalRemaining)} total received)</p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-emerald-500 shadow-sm hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Capital Locked In</CardTitle>
            <ArrowUpRight className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-extrabold text-emerald-600">{rupees(totalValuation)}</div>
            <p className="text-[10px] text-muted-foreground mt-1">Total raw stock asset valuation</p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-amber-500 shadow-sm hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Weighted Avg Cost</CardTitle>
            <ArrowDownRight className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-extrabold text-amber-600">{overallWac > 0 ? `${rupees(overallWac)}/kg` : '-'}</div>
            <p className="text-[10px] text-muted-foreground mt-1">Our average raw stock cost basis</p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-indigo-500 shadow-sm hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Supplier Risk</CardTitle>
            <Users className="h-4 w-4 text-indigo-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-extrabold text-indigo-600">
              {topSupplier ? `${supplierConcentrationPct.toFixed(1)}%` : '-'}
            </div>
            <p className="text-[10px] text-muted-foreground mt-1 truncate">
              {topSupplier ? `Held by top supplier: ${topSupplier.partyName}` : 'No active suppliers'}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ─── Blend-to-Target Planner ─────────────────────────────────────── */}
      <Card className="border-l-4 border-l-primary shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Target className="h-4 w-4 text-primary" /> Average-Cost Blender
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Your stock sits at <span className="font-semibold text-foreground">{overallWac > 0 ? `${rupees(overallWac)}/kg` : '-'}</span> avg.
            Enter the average you want and the price you can buy fresh black seed at - see how much to buy to pull the blend down, overall and per supplier.
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl">
            <div className="space-y-1">
              <Label htmlFor="target-avg" className="text-xs text-muted-foreground">Target average (₹/kg)</Label>
              <Input
                id="target-avg"
                type="number"
                min="0"
                step="0.5"
                value={targetInput}
                onChange={(e) => setTargetInput(e.target.value)}
                placeholder="e.g. 30"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="buy-price" className="text-xs text-muted-foreground">Buy price (₹/kg)</Label>
              <Input
                id="buy-price"
                type="number"
                min="0"
                step="0.5"
                value={buyPriceInput}
                onChange={(e) => setBuyPriceInput(e.target.value)}
                placeholder={lowestBandPrice > 0 ? `e.g. ${rupees(lowestBandPrice)} (cheapest band)` : 'e.g. 25'}
              />
            </div>
            <div className="flex items-end pb-0.5">
              {!buyPriceInput.trim() && lowestBandPrice > 0 && hasTarget && (
                <p className="text-[11px] text-muted-foreground">
                  Using cheapest band <span className="font-semibold text-foreground">{rupees(lowestBandPrice)}/kg</span> as buy price.
                </p>
              )}
            </div>
          </div>

          {!planActive && (
            <p className="text-sm text-muted-foreground">Enter a target average to plan a blend.</p>
          )}

          {wholeResult && wholeResult.status === 'infeasible' && (
            <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>Buy price <span className="font-semibold">{rupees(buyPrice)}/kg</span> is not below the target <span className="font-semibold">{rupees(targetAvg)}/kg</span>. You can't pull an average below the price you buy at - lower the buy price or raise the target.</span>
            </div>
          )}

          {wholeResult && wholeResult.status === 'already' && (
            <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
              <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
              <span>Target <span className="font-semibold">{rupees(targetAvg)}/kg</span> is already at or above your current average <span className="font-semibold">{rupees(overallWac)}/kg</span> - no buying needed.</span>
            </div>
          )}

          {wholeResult && wholeResult.status === 'nostock' && (
            <p className="text-sm text-muted-foreground">No raw stock on hand to blend against.</p>
          )}

          {wholeResult && wholeResult.status === 'ok' && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-primary flex items-center gap-1">
                  <ShoppingCart className="h-3 w-3" /> Buy
                </div>
                <div className="text-xl font-bold text-primary mt-1">{toTonnes(wholeResult.kg).toFixed(2)} MT</div>
                <div className="text-[10px] text-muted-foreground">at {rupees(buyPrice)}/kg ({kg(wholeResult.kg)})</div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">New Avg</div>
                <div className="text-xl font-bold text-amber-600 mt-1">{rupees(targetAvg)}/kg</div>
                <div className="text-[10px] text-muted-foreground">down from {rupees(overallWac)}/kg</div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">New Total Stock</div>
                <div className="text-xl font-bold mt-1">{toTonnes(newTotalKg).toFixed(2)} MT</div>
                <div className="text-[10px] text-muted-foreground">from {toTonnes(totalRemaining).toFixed(2)} MT</div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">New Valuation</div>
                <div className="text-xl font-bold text-emerald-600 mt-1">{rupees(newValuation)}</div>
                <div className="text-[10px] text-muted-foreground">+{rupees(wholeResult.kg * buyPrice)} fresh capital</div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Price Distribution Analysis Card */}
      {overallPricePools.length > 0 && (
        <Card className="shadow-sm hover:shadow-md transition-shadow p-5">
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">Inventory Cost Basis & Price Bands</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Visualize how much inventory capital and tonnage is grouped at different purchase price levels.
            </p>
          </div>
          <div className="space-y-4">
            <div className="h-4 w-full bg-muted rounded-full flex overflow-hidden shadow-inner">
              {overallPricePools.map((pool, idx) => {
                const colors = [
                  'bg-emerald-500',
                  'bg-teal-500',
                  'bg-indigo-500',
                  'bg-amber-500',
                  'bg-sky-500',
                  'bg-rose-500'
                ];
                const color = colors[idx % colors.length];
                return (
                  <div
                    key={pool.price}
                    className={`${color} h-full transition-all`}
                    style={{ width: `${pool.pct}%` }}
                    title={`${rupees(pool.price)}/kg: ${pool.pct.toFixed(1)}%`}
                  />
                );
              })}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-4 pt-2">
              {overallPricePools.map((pool, idx) => {
                const colors = [
                  'bg-emerald-500',
                  'bg-teal-500',
                  'bg-indigo-500',
                  'bg-amber-500',
                  'bg-sky-500',
                  'bg-rose-500'
                ];
                const color = colors[idx % colors.length];
                return (
                  <div key={pool.price} className="flex items-start gap-2">
                    <span className={`h-3 w-3 rounded-full mt-0.5 shrink-0 ${color}`} />
                    <div className="space-y-0.5">
                      <div className="text-xs font-bold text-foreground">
                        {rupees(pool.price)}/kg
                      </div>
                      <div className="text-[10px] text-muted-foreground font-semibold">
                        {toTonnes(pool.weight).toFixed(2)} MT ({pool.pct.toFixed(1)}%)
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </Card>
      )}

      {/* Main Table Card */}
      <Card>
        <div className="px-5 py-4 border-b flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-muted/10 rounded-t-xl">
          <div>
            <h3 className="font-semibold text-sm">Supplier Inventory Ledger</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Summary of total historical stock received, average cost basis, and total valuation per party. Expand a supplier to view price pooling details.
            </p>
          </div>
          <div className="relative w-64">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search supplier or location…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 bg-card"
            />
          </div>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10"></TableHead>
              <TableHead>Supplier Party</TableHead>
              <TableHead>Location / Address</TableHead>
              <TableHead className="text-right font-bold text-primary">Total Received Stock</TableHead>
              <TableHead className="text-right">Avg Cost (WAC)</TableHead>
              <TableHead className="text-right">Valuation</TableHead>
              <TableHead className="text-right">
                {planActive ? `Buy to reach ${rupees(targetAvg)}` : 'Buy to reach target'}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredPartyStocks.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                  No supplier stock details found.
                </TableCell>
              </TableRow>
            ) : (
              filteredPartyStocks.map((p) => {
                const isExpanded = expandedParties.has(p.partyId);
                const hasStock = p.netStockKg > 0;
                
                return (
                  <Fragment key={p.partyId}>
                    <TableRow 
                      className={`hover:bg-muted/50 ${hasStock ? 'cursor-pointer font-medium' : 'opacity-60'}`}
                      onClick={() => hasStock && toggleParty(p.partyId)}
                    >
                      <TableCell className="p-3 text-center">
                        {hasStock && (
                          isExpanded ? <ChevronDown className="h-4 w-4 mx-auto text-muted-foreground" /> : <ChevronRight className="h-4 w-4 mx-auto text-muted-foreground" />
                        )}
                      </TableCell>
                      <TableCell className="font-bold text-foreground">
                        <div className="flex items-center gap-2">
                          <Users className="h-4 w-4 text-muted-foreground" />
                          <span>{p.partyName}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">{p.address}</div>
                        {p.phone && <div className="text-xs text-muted-foreground font-mono">{p.phone}</div>}
                      </TableCell>
                      <TableCell className="text-right font-extrabold text-primary">
                        {toTonnes(p.netStockKg).toFixed(2)} MT
                        <span className="block text-[10px] text-primary/70 font-semibold">({kg(p.netStockKg)})</span>
                      </TableCell>
                      <TableCell className="text-right font-semibold text-amber-600">
                        {p.weightedAveragePrice > 0 ? `${rupees(p.weightedAveragePrice)}/kg` : '-'}
                      </TableCell>
                      <TableCell className="text-right font-extrabold text-emerald-600">
                        {p.totalValuation > 0 ? rupees(p.totalValuation) : '-'}
                      </TableCell>
                      <TableCell className="text-right text-sm">
                        {(() => {
                          if (!planActive) return <span className="text-muted-foreground">-</span>;
                          const r = buyKgToReachTarget(p.netStockKg, p.weightedAveragePrice, targetAvg, buyPrice);
                          if (r.status === 'ok') {
                            return (
                              <span className="font-bold text-primary">
                                {toTonnes(r.kg).toFixed(2)} MT
                                <span className="block text-[10px] text-muted-foreground font-medium">at {rupees(buyPrice)}/kg</span>
                              </span>
                            );
                          }
                          if (r.status === 'already') {
                            return <span className="text-[11px] text-emerald-600 font-medium">already ≤ target</span>;
                          }
                          if (r.status === 'infeasible') {
                            return <span className="text-[11px] text-rose-500 font-medium">price ≥ target</span>;
                          }
                          return <span className="text-muted-foreground">-</span>;
                        })()}
                      </TableCell>
                    </TableRow>
                    
                    {isExpanded && hasStock && (
                      <TableRow className="bg-muted/10 hover:bg-muted/10">
                        <TableCell colSpan={7} className="p-4 pl-12">
                          <div className="max-w-2xl rounded-lg border bg-card p-4 shadow-sm space-y-3">
                            <div className="flex items-center justify-between border-b pb-2">
                              <span className="font-bold text-xs text-muted-foreground uppercase tracking-wider">
                                Price Pool Breakdown
                              </span>
                              <span className="text-xs text-muted-foreground font-semibold">
                                {p.pricePools?.length || 0} Pool(s) Active
                              </span>
                            </div>
                            
                            {(!p.pricePools || p.pricePools.length === 0) ? (
                              <div className="text-center text-xs text-muted-foreground py-2">
                                No active price pools for this supplier.
                              </div>
                            ) : (
                              <div className="overflow-x-auto">
                                <Table>
                                  <TableHeader className="bg-muted/40">
                                    <TableRow className="hover:bg-transparent">
                                      <TableHead className="h-8 py-1 text-xs">Price</TableHead>
                                      <TableHead className="h-8 py-1 text-xs text-right">Total Purchased</TableHead>
                                      <TableHead className="h-8 py-1 text-xs text-right">Valuation</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {p.pricePools.map((pool) => (
                                      <TableRow key={pool.pricePerKg} className="hover:bg-muted/20">
                                        <TableCell className="py-2 text-xs font-bold text-foreground">
                                          <Badge variant="outline" className="bg-primary/5 text-primary border-primary/20 text-[10px] font-extrabold px-2 py-0.5">
                                            {rupees(pool.pricePerKg)}/kg
                                          </Badge>
                                        </TableCell>
                                        <TableCell className="py-2 text-xs text-right font-extrabold text-primary">
                                          {toTonnes(pool.totalPurchasedKg).toFixed(2)} MT <span className="text-[10px] text-muted-foreground font-semibold">({kg(pool.totalPurchasedKg)})</span>
                                        </TableCell>
                                        <TableCell className="py-2 text-xs text-right font-bold text-emerald-600">
                                          {rupees(pool.purchasedValue)}
                                        </TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              </div>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
