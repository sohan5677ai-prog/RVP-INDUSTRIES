import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Warehouse, IndianRupee, Package, ClipboardList, TrendingUp } from 'lucide-react';
import { api } from '@/lib/api';
import { kg, rupees, rupeesShort, shortDate, toTonnes } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface BlackSeedRow {
  purchaseId: string;
  date: string;
  invoiceNumber: string;
  partyName: string;
  poNumber: string | null;
  lorryNumber: string;
  rvpNetWeightKg: number;
  location: string;
  pricePerKg: number;
  hamaliCharge: number;
  companyHamali: number;
  value: number;
  valueExclHamali: number;
  verified: boolean;
}

interface BlackSeedStockResponse {
  rows: BlackSeedRow[];
  pappuSoldKg: number;
  poTonnageKg: number;
}

// Standard milling out-turn: 60% of raw black seed yields pappu.
const PAPPU_OUTTURN = 0.6;

export default function BlackSeedStock() {
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [partySearch, setPartySearch] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['black-seed-stock'],
    queryFn: () => api<BlackSeedStockResponse>('/inventory/black-seed'),
  });

  const allItems = data?.rows ?? [];
  // Date-filtered rows drive the ledger table and the weighted-average price tile.
  const items = allItems.filter((r) => {
    const d = r.date.slice(0, 10);
    if (fromDate && d < fromDate) return false;
    if (toDate && d > toDate) return false;
    if (partySearch && !r.partyName.toLowerCase().includes(partySearch.toLowerCase())) return false;
    return true;
  });

  // Weighted-average price per kg across the filtered rows (weighted by net weight).
  const filteredWeightKg = items.reduce((sum, r) => sum + r.rvpNetWeightKg, 0);
  const weightedPriceSum = items.reduce((sum, r) => sum + r.pricePerKg * r.rvpNetWeightKg, 0);
  const weightedAvgPrice = filteredWeightKg > 0 ? weightedPriceSum / filteredWeightKg : 0;
  const pappuSoldKg = data?.pappuSoldKg ?? 0;
  const poTonnageKg = data?.poTonnageKg ?? 0;
  // Black seed received (purchased). Milling does NOT reduce this — only sales do.
  const receivedWeightKg = allItems.reduce((sum, r) => sum + r.rvpNetWeightKg, 0);
  const totalValue = allItems.reduce((sum, r) => sum + r.valueExclHamali, 0);

  // Selling pappu depletes everything. Each kg of pappu sold consumed
  // (1 / 60%) kg of black seed to produce.
  const seedConsumedBySalesKg = pappuSoldKg / PAPPU_OUTTURN;
  // Raw black seed on hand = received − seed used to make the pappu already sold.
  const rawStockOnHandKg = Math.max(0, receivedWeightKg - seedConsumedBySalesKg);
  // Pappu available = 60% of received seed, less pappu already sold.
  const availablePappuKg = Math.max(0, receivedWeightKg * PAPPU_OUTTURN - pappuSoldKg);
  // Pappu committed = 60% of all ordered tonnage, less pappu already sold.
  const committedPappuKg = Math.max(0, poTonnageKg * PAPPU_OUTTURN - pappuSoldKg);

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
        <h1 className="text-2xl font-bold">Black Seed Stock</h1>
        <p className="text-muted-foreground">
          Raw black seed on hand, lorry by lorry.
        </p>
      </div>

      {/* Date filter */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="from-date" className="text-xs text-muted-foreground">From</Label>
          <Input
            id="from-date"
            type="date"
            value={fromDate}
            max={toDate || undefined}
            onChange={(e) => setFromDate(e.target.value)}
            className="w-40"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="to-date" className="text-xs text-muted-foreground">To</Label>
          <Input
            id="to-date"
            type="date"
            value={toDate}
            min={fromDate || undefined}
            onChange={(e) => setToDate(e.target.value)}
            className="w-40"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="party-search" className="text-xs text-muted-foreground">Party Name</Label>
          <Input
            id="party-search"
            type="search"
            list="parties-list"
            placeholder="Search party..."
            value={partySearch}
            onChange={(e) => setPartySearch(e.target.value)}
            className="w-48"
          />
          <datalist id="parties-list">
            {Array.from(new Set(allItems.map(r => r.partyName))).map(p => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </div>
        {(fromDate || toDate || partySearch) && (
          <button
            type="button"
            onClick={() => { setFromDate(''); setToDate(''); setPartySearch(''); }}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline pb-2.5"
          >
            Clear
          </button>
        )}
      </div>

      {/* KPI summary */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Raw Stock</CardTitle>
            <Warehouse className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{toTonnes(rawStockOnHandKg).toFixed(2)} MT</div>
            <p className="text-[10px] text-muted-foreground mt-1">
              {kg(receivedWeightKg)} received{seedConsumedBySalesKg > 0 ? ` − ${kg(Math.round(seedConsumedBySalesKg))} used for pappu sold` : ` across ${allItems.length} lorries`}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Committed Pappu</CardTitle>
            <ClipboardList className="h-4 w-4 text-violet-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-violet-600">{toTonnes(committedPappuKg).toFixed(2)} MT</div>
            <p className="text-[10px] text-muted-foreground mt-1">
              60% of {toTonnes(poTonnageKg).toFixed(2)} MT ordered − {kg(pappuSoldKg)} sold
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Available Pappu</CardTitle>
            <Package className="h-4 w-4 text-sky-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-sky-600">{toTonnes(availablePappuKg).toFixed(2)} MT</div>
            <p className="text-[10px] text-muted-foreground mt-1">
              60% of {toTonnes(receivedWeightKg).toFixed(2)} MT received − {kg(pappuSoldKg)} sold
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Stock Valuation</CardTitle>
            <IndianRupee className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-emerald-600" title={rupees(totalValue)}>{rupeesShort(totalValue)}</div>
            <p className="text-[10px] text-muted-foreground mt-1">Seed cost + freight (if BASE price)</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Weighted Avg Price</CardTitle>
            <TrendingUp className="h-4 w-4 text-rose-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-rose-600">{rupees(weightedAvgPrice)}/kg</div>
            <p className="text-[10px] text-muted-foreground mt-1">
              {fromDate || toDate ? 'Filtered' : 'All'} stock · {toTonnes(filteredWeightKg).toFixed(2)} MT
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Detailed stock ledger */}
      <div className="rounded-lg border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Invoice No</TableHead>
              <TableHead>Lorry No</TableHead>
              <TableHead>Party Name</TableHead>
              <TableHead className="text-right">RVP Net Weight</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead>Location</TableHead>
              <TableHead className="text-right">Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                  {fromDate || toDate
                    ? 'No black seed stock in the selected date range.'
                    : 'No black seed in stock. Approve purchases on the Verification page to add stock.'}
                </TableCell>
              </TableRow>
            )}
            {items.map((r) => (
              <TableRow key={r.purchaseId}>
                <TableCell>{shortDate(r.date)}</TableCell>
                <TableCell className="font-semibold">
                  {r.invoiceNumber}
                  {r.poNumber && <span className="ml-2 text-[11px] text-muted-foreground font-mono">({r.poNumber})</span>}
                </TableCell>
                <TableCell className="font-mono text-sm font-semibold">{r.lorryNumber}</TableCell>
                <TableCell className="font-medium">{r.partyName}</TableCell>
                <TableCell className="text-right font-semibold">{kg(r.rvpNetWeightKg)}</TableCell>
                <TableCell className="text-right font-medium">{rupees(r.pricePerKg)}/kg</TableCell>
                <TableCell><Badge variant="outline">{r.location}</Badge></TableCell>
                <TableCell className="text-right">
                  <div className="font-semibold text-emerald-600">{rupees(r.valueExclHamali)}</div>
                  {!r.verified && (
                    <div className="text-[10px] text-amber-600">unverified</div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
