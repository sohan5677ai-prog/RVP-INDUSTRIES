import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, Loader2, Users, ArrowUpRight, ArrowDownRight, Archive, ChevronRight, ChevronDown } from 'lucide-react';
import { api } from '@/lib/api';
import { kg, rupees, toTonnes } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

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
            <p className="text-[10px] text-muted-foreground mt-1">({kg(totalRemaining)} net remaining)</p>
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
            <div className="text-2xl font-extrabold text-amber-600">{overallWac > 0 ? `${rupees(overallWac)}/kg` : '—'}</div>
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
              {topSupplier ? `${supplierConcentrationPct.toFixed(1)}%` : '—'}
            </div>
            <p className="text-[10px] text-muted-foreground mt-1 truncate">
              {topSupplier ? `Held by top supplier: ${topSupplier.partyName}` : 'No active suppliers'}
            </p>
          </CardContent>
        </Card>
      </div>

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
              Summary of total raw stock on hand, cost basis, and valuation per party. Expand a supplier to view price pooling details.
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
              <TableHead className="text-right font-bold text-primary">Net Stock Remaining</TableHead>
              <TableHead className="text-right">Avg Cost (WAC)</TableHead>
              <TableHead className="text-right">Valuation</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredPartyStocks.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
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
                        {p.weightedAveragePrice > 0 ? `${rupees(p.weightedAveragePrice)}/kg` : '—'}
                      </TableCell>
                      <TableCell className="text-right font-extrabold text-emerald-600">
                        {p.totalValuation > 0 ? rupees(p.totalValuation) : '—'}
                      </TableCell>
                    </TableRow>
                    
                    {isExpanded && hasStock && (
                      <TableRow className="bg-muted/10 hover:bg-muted/10">
                        <TableCell colSpan={6} className="p-4 pl-12">
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
                                          {pool.totalMilledKg > 0 && (
                                            <span className="block text-[10px] text-muted-foreground font-medium">
                                              {toTonnes(pool.netStockKg).toFixed(2)} MT remaining after milling
                                            </span>
                                          )}
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
