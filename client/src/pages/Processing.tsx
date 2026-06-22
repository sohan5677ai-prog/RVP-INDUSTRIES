import { useQuery } from '@tanstack/react-query';
import { Loader2, Sparkles } from 'lucide-react';
import { api } from '@/lib/api';
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
}

interface BlackSeedStockResponse {
  rows: BlackSeedRow[];
}

const PAPPU = 0.6;
const HUSK = 0.25;
const WASTE = 0.1;

export default function Processing() {
  const { data, isLoading } = useQuery({
    queryKey: ['black-seed-stock'],
    queryFn: () => api<BlackSeedStockResponse>('/inventory/black-seed'),
  });

  const rows = data?.rows ?? [];
  const totalSeed = rows.reduce((sum, r) => sum + r.rvpNetWeightKg, 0);

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
          Outputs are derived as 60% Pappu / 25% Husk / 10% Waste of arrived black seed — no batch milling.
        </p>
      </div>

      {/* Pool summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="rounded-lg border bg-card p-4">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Black Seed Pool</div>
          <div className="text-2xl font-bold text-primary mt-1">{toTonnes(totalSeed).toFixed(2)} MT</div>
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
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Tamarind Waste (10%)</div>
          <div className="text-2xl font-bold text-stone-600 mt-1">{toTonnes(Math.round(totalSeed * WASTE)).toFixed(2)} MT</div>
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
