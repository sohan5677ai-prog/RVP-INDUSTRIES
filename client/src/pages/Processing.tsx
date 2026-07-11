import { useQuery } from '@tanstack/react-query';
import { Loader2, Sparkles } from 'lucide-react';
import { api } from '@/lib/api';
import { stockSummary, type ByPriceBandLike } from '@/lib/calc';
import { kg, shortDate, toTonnes } from '@/lib/format';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

interface BlackSeedRow {
  purchaseId: string;
  date: string;
  invoiceNumber: string;
  partyName: string;
  poNumber: string | null;
  lorryNumber: string;
  rvpNetWeightKg: number;
  location: string;
}

interface BlackSeedStockResponse {
  rows: BlackSeedRow[];
  pappuCommittedKg: number;
  // kg sold from the shared 10% pool (shell + waste + pre-cleaner byproducts).
  wastePoolSoldKg: number;
}

interface StockByPriceResponse {
  bands: ByPriceBandLike[];
}

const PAPPU = 0.6;
const HUSK = 0.25;
const WASTE = 0.1;

export default function Processing() {
  const { data, isLoading: loadingStock } = useQuery({
    queryKey: ['black-seed-stock'],
    queryFn: () => api<BlackSeedStockResponse>('/inventory/black-seed'),
  });

  const { data: plannerData, isLoading: loadingPlanner } = useQuery({
    queryKey: ['stock-by-price'],
    queryFn: () => api<StockByPriceResponse>('/inventory/by-price'),
  });

  const isLoading = loadingStock || loadingPlanner;

  const allRows = data?.rows ?? [];
  const rows = allRows.filter((r) => (r.location || 'RVP') === 'RVP');
  // RVP live stock mirrors the Order Planner's "Black Seed Remaining": arrived
  // seed net of the sales draw-down. Derived from the same bands so the figure
  // (and its 60/25/10 split) is identical to the Order Planner.
  const summary = stockSummary(plannerData?.bands);
  const receivedSeed = summary.arrivedBlackKg;
  const seedConsumedByPappuKg = Math.max(0, summary.arrivedBlackKg - summary.remainingBlackKg);
  const totalSeed = summary.remainingBlackKg;

  // The 10% "Pre Cleaner Husk & Tamarind" pool is a single shared byproduct pool:
  // 10% of every arrival, drawn down by shell + waste + pre-cleaner sales.
  const wastePoolSoldKg = data?.wastePoolSoldKg ?? 0;
  const wasteAvailableKg = Math.max(0, Math.round(receivedSeed * WASTE) - wastePoolSoldKg);

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
        <h1 className="text-2xl font-bold">Conversion</h1>
        <p className="text-muted-foreground flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          Outputs are derived as 60% Pappu / 25% Husk / 10% Waste of arrived black seed - no batch milling.
        </p>
      </div>

      {/* Pool summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="rounded-lg border bg-card p-4">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">RVP Live Stock</div>
          <div className="text-2xl font-bold text-primary mt-1">{toTonnes(totalSeed).toFixed(2)} MT</div>
          {seedConsumedByPappuKg > 0 && (
            <div className="text-[10px] text-muted-foreground mt-1">
              {toTonnes(receivedSeed).toFixed(2)} MT received − {toTonnes(seedConsumedByPappuKg).toFixed(2)} MT for pappu sold
            </div>
          )}
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Pappu (60%)</div>
          <div className="text-2xl font-bold text-indigo-600 mt-1">{toTonnes(Math.round(totalSeed * PAPPU)).toFixed(2)} MT</div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Husk (25%)</div>
          <div className="text-2xl font-bold text-amber-600 mt-1">{toTonnes(Math.round(totalSeed * HUSK)).toFixed(2)} MT</div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Pre Cleaner Husk & Tamarind (10%)</div>
          <div className="text-2xl font-bold text-stone-600 mt-1">{toTonnes(wasteAvailableKg).toFixed(2)} MT</div>
          {wastePoolSoldKg > 0 && (
            <div className="text-[10px] text-muted-foreground mt-1">
              {toTonnes(Math.round(receivedSeed * WASTE)).toFixed(2)} MT (10%) − {toTonnes(wastePoolSoldKg).toFixed(2)} MT byproduct sales
            </div>
          )}
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
              <TableHead className="text-right">Total Weight</TableHead>
              <TableHead className="text-right">Pappu (60%)</TableHead>
              <TableHead className="text-right">Husk (25%)</TableHead>
              <TableHead className="text-right">Waste (10%)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                  No black seed received yet. Verify a purchase to see its output split.
                </TableCell>
              </TableRow>
            )}
            {rows.map((r) => (
              <TableRow key={r.purchaseId}>
                <TableCell>{shortDate(r.date)}</TableCell>
                <TableCell className="font-medium">{r.partyName}</TableCell>
                <TableCell className="font-semibold">{r.invoiceNumber}</TableCell>
                <TableCell className="font-mono text-sm">{r.lorryNumber}</TableCell>
                <TableCell className="text-right font-medium">{kg(r.rvpNetWeightKg)}</TableCell>
                <TableCell className="text-right font-bold text-indigo-600">{kg(Math.round(r.rvpNetWeightKg * PAPPU))}</TableCell>
                <TableCell className="text-right font-semibold text-amber-600">{kg(Math.round(r.rvpNetWeightKg * HUSK))}</TableCell>
                <TableCell className="text-right font-semibold text-stone-600">{kg(Math.round(r.rvpNetWeightKg * WASTE))}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
