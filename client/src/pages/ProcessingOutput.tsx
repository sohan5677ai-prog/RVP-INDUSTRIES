import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Search, Package, ClipboardList } from 'lucide-react';
import { api } from '@/lib/api';
import { stockSummary } from '@/lib/calc';
import { kg, rupees, shortDate, toTonnes } from '@/lib/format';
import { Input } from '@/components/ui/input';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export type OutputProduct = 'pappu' | 'husk' | 'waste';

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
  value: number;
}

interface BlackSeedStockResponse {
  rows: BlackSeedRow[];
  pappuSoldKg: number;
  huskSoldKg: number;
  wasteSoldKg: number;
  // Total sold from the shared 10% pool: shell + waste + pre-cleaner byproducts.
  wastePoolSoldKg: number;
  pendingPoTonnageKg: number;
}

const PAPPU_OUTTURN = 0.6;

const PRODUCT_META: Record<OutputProduct, {
  title: string;
  noun: string;
  pct: number;
  outputLabel: string;
  accent: string;
}> = {
  pappu: { title: 'Pappu (60%)', noun: 'Pappu', pct: 0.6, outputLabel: 'Pappu Output', accent: 'text-indigo-600' },
  husk: { title: 'Husk (25%)', noun: 'Husk', pct: 0.25, outputLabel: 'Husk Output', accent: 'text-amber-600' },
  waste: { title: 'Pre Cleaner Husk & Tamarind (10%)', noun: 'Waste', pct: 0.1, outputLabel: 'Waste Output', accent: 'text-stone-600' },
};

interface PriceBandResponse {
  arrivedBlackKg: number;
  remainingBlackKg: number;
  pendingBlackKg: number;
  pendingConsumableBlackKg: number;
}

interface StockByPriceResponse {
  bands: PriceBandResponse[];
}

export default function ProcessingOutput({ product }: { product: OutputProduct }) {
  const meta = PRODUCT_META[product];
  const [searchQuery, setSearchQuery] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const { data: stockData, isLoading: loadingStock } = useQuery({
    queryKey: ['black-seed-stock'],
    queryFn: () => api<BlackSeedStockResponse>('/inventory/black-seed'),
  });

  const { data: plannerData, isLoading: loadingPlanner } = useQuery({
    queryKey: ['stock-by-price'],
    queryFn: () => api<StockByPriceResponse>('/inventory/by-price'),
  });

  const isLoading = loadingStock || loadingPlanner;

  // Configurable per-kg production cost (sum of components from Settings).
  const { data: prodCostComponents } = useQuery({
    queryKey: ['production-cost'],
    queryFn: () => api<{ ratePerKg: string | number }[]>('/settings/production-cost'),
  });
  const productionCostPerKg = (prodCostComponents ?? []).reduce((s, c) => s + Number(c.ratePerKg), 0);

  const allRows = stockData?.rows ?? [];
  const rows = allRows.filter((r) => (r.location || 'RVP') === 'RVP');
  const bands = plannerData?.bands ?? [];

  let availableKg = 0;
  let committedKg = 0;

  if (product === 'pappu') {
    // Pappu strictly mirrors the Order Planner via the shared helper:
    //   Available = remaining seed (after sales draw-down) × out-turn.
    //   Committed = Available + CONSUMABLE pending seed × out-turn (buffer excluded).
    const summary = stockSummary(bands);
    availableKg = summary.availablePappuKg;
    committedKg = summary.committedPappuKg;
  } else {
    // Husk and Waste use the planner's total gross arrived and pending seed, minus their own sales.
    const totalArrivedBlackKg = bands.reduce((sum, b) => sum + b.arrivedBlackKg, 0);
    const totalPendingBlackKg = bands.reduce((sum, b) => sum + b.pendingBlackKg, 0);
    // Waste draws down the shared 10% pool across all byproducts (shell + waste +
    // pre-cleaner dust + nalla pokkulu + nalla chintapandu); husk uses its own sales.
    const soldKg = product === 'husk' ? (stockData?.huskSoldKg ?? 0) : (stockData?.wastePoolSoldKg ?? 0);
    
    availableKg = Math.max(0, meta.pct * totalArrivedBlackKg - soldKg);
    committedKg = availableKg + (meta.pct * totalPendingBlackKg);
  }

  // Gross black seed received (arrived across all price bands), shown in the KPI subtitle.
  const receivedKg = bands.reduce((sum, b) => sum + b.arrivedBlackKg, 0);


  const filteredRows = rows.filter((r) => {
    const term = searchQuery.toLowerCase();
    const matchParty = !term || r.partyName.toLowerCase().includes(term);
    const day = r.date.slice(0, 10);
    const matchFrom = !fromDate || day >= fromDate;
    const matchTo = !toDate || day <= toDate;
    return matchParty && matchFrom && matchTo;
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
        <h1 className="text-2xl font-bold">{meta.title}</h1>
        <p className="text-muted-foreground">
          {Math.round(meta.pct * 100)}% of every black-seed arrival, depleted as {product === 'waste' ? 'byproducts (shell, waste, pre-cleaner) are' : `${meta.noun.toLowerCase()} is`} sold.
        </p>
      </div>

      {/* KPI tiles */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Available</CardTitle>
            <Package className={`h-4 w-4 ${meta.accent}`} />
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${meta.accent}`}>{toTonnes(availableKg).toFixed(2)} MT</div>
            <p className="text-[10px] text-muted-foreground mt-1">
              {Math.round(meta.pct * 100)}% of {toTonnes(receivedKg).toFixed(2)} MT received − sales
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Committed</CardTitle>
            <ClipboardList className="h-4 w-4 text-violet-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-violet-600">{toTonnes(committedKg).toFixed(2)} MT</div>
            <p className="text-[10px] text-muted-foreground mt-1">
              Available + pending PO {meta.noun.toLowerCase()}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
        <div className="relative sm:w-64">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search party…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 bg-card"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">From</label>
          <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="w-40 bg-card" />
          <label className="text-xs text-muted-foreground">To</label>
          <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="w-40 bg-card" />
        </div>
      </div>

      <div className="rounded-lg border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Party Name</TableHead>
              <TableHead>Invoice No</TableHead>
              <TableHead>Vehicle No</TableHead>
              {product === 'pappu' && (
                <>
                  <TableHead className="text-right">Seed Price</TableHead>
                  <TableHead className="text-right">Pappu Cost Price</TableHead>
                </>
              )}
              <TableHead className="text-right">Total Weight</TableHead>
              <TableHead className="text-right">{meta.outputLabel}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredRows.length === 0 && (
              <TableRow>
                <TableCell colSpan={product === 'pappu' ? 8 : 6} className="text-center text-muted-foreground py-8">
                  No matching black-seed arrivals.
                </TableCell>
              </TableRow>
            )}
            {filteredRows.map((r) => {
              const rowPappuCost = r.pricePerKg / PAPPU_OUTTURN + productionCostPerKg;
              return (
                <TableRow key={r.purchaseId}>
                  <TableCell>{shortDate(r.date)}</TableCell>
                  <TableCell className="font-medium">{r.partyName}</TableCell>
                  <TableCell className="font-semibold">{r.invoiceNumber}</TableCell>
                  <TableCell className="font-mono text-sm">{r.lorryNumber}</TableCell>
                  {product === 'pappu' && (
                    <>
                      <TableCell className="text-right font-medium">{rupees(r.pricePerKg)}/kg</TableCell>
                      <TableCell className="text-right font-bold text-sky-600">{rupees(rowPappuCost)}/kg</TableCell>
                    </>
                  )}
                  <TableCell className="text-right font-medium">{kg(r.rvpNetWeightKg)}</TableCell>
                  <TableCell className={`text-right font-bold ${meta.accent}`}>
                    {kg(Math.round(r.rvpNetWeightKg * meta.pct))}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
