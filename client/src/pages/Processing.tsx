import { useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { api } from '@/lib/api';
import type { Processing as ProcessingType } from '@/lib/types';
import { kg, rupees, shortDate } from '@/lib/format';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';

export default function Processing() {
  const { data: items, isLoading } = useQuery({
    queryKey: ['processing'],
    queryFn: () => api<ProcessingType[]>('/processing'),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Processing</h1>
        <p className="text-muted-foreground flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          Batches are milled automatically when a purchase is approved on the Verification page.
        </p>
      </div>

      <div className="rounded-lg border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Source Purchase / Lorry</TableHead>
              <TableHead className="text-right">Black Input (kg)</TableHead>
              <TableHead className="text-right">Out-turn</TableHead>
              <TableHead>Yield Distribution</TableHead>
              <TableHead className="text-right">Pappu Output</TableHead>
              <TableHead>Pricing</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">Loading…</TableCell></TableRow>
            )}
            {!isLoading && items?.length === 0 && (
              <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">No processing batches yet. Approve a purchase on the Verification page to mill it.</TableCell></TableRow>
            )}
            {items?.map((it) => {
              const total = it.blackWeightKg || 1;
              const pappuPct = (it.pappuWeightKg / total) * 100;
              const huskPct = (it.huskWeightKg / total) * 100;
              const wastePct = (it.wasteWeightKg / total) * 100;
              const lostPct = (it.lostWeightKg / total) * 100;

              return (
                <TableRow key={it.id}>
                  <TableCell>{shortDate(it.processDate)}</TableCell>
                  <TableCell>
                    {it.purchase ? (
                      <div>
                        <span className="font-semibold text-sm">
                          {it.purchase.stockIn?.purchaseOrder?.party?.name ?? '—'}
                        </span>
                        <span className="ml-2 text-xs text-muted-foreground font-mono">
                          ({it.purchase.stockIn?.purchaseOrder?.poNumber})
                        </span>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          Inv {it.purchase.stockIn?.invoiceNumber} · Lorry {it.purchase.stockIn?.lorryNumber} · Wt: {kg(it.purchase.netWeightKg)}
                        </div>
                      </div>
                    ) : (
                      <span className="text-muted-foreground text-xs italic">Standalone Pool ({it.loadingLocation})</span>
                    )}
                    {it.yieldAnomaly && (
                      <Badge variant="destructive" className="ml-2 animate-pulse" title={it.yieldAnomalyReason || ''}>Anomaly</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-medium">{kg(it.blackWeightKg)}</TableCell>
                  <TableCell className="text-right">{Number(it.outTurnPct)}%</TableCell>
                  <TableCell>
                    <div className="space-y-1.5 w-60 py-1">
                      <div className="h-3 w-full bg-muted rounded-full overflow-hidden flex shadow-inner">
                        <div
                          className="h-full bg-indigo-600 transition-all duration-300 hover:opacity-95"
                          style={{ width: `${pappuPct}%` }}
                          title={`Pappu: ${kg(it.pappuWeightKg)} (${pappuPct.toFixed(1)}%)`}
                        />
                        <div
                          className="h-full bg-amber-500 transition-all duration-300 hover:opacity-95"
                          style={{ width: `${huskPct}%` }}
                          title={`Husk: ${kg(it.huskWeightKg)} (${huskPct.toFixed(1)}%)`}
                        />
                        <div
                          className="h-full bg-stone-500 transition-all duration-300 hover:opacity-95"
                          style={{ width: `${wastePct}%` }}
                          title={`Waste: ${kg(it.wasteWeightKg)} (${wastePct.toFixed(1)}%)`}
                        />
                        <div
                          className="h-full bg-red-400 transition-all duration-300 hover:opacity-95"
                          style={{ width: `${lostPct}%` }}
                          title={`Shrinkage Loss: ${kg(it.lostWeightKg)} (${lostPct.toFixed(1)}%)`}
                        />
                      </div>
                      <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[9px] text-muted-foreground font-semibold uppercase tracking-wider">
                        <span className="flex items-center gap-0.5">
                          <span className="h-1.5 w-1.5 bg-indigo-600 rounded-full" />
                          Pappu: {pappuPct.toFixed(0)}%
                        </span>
                        <span className="flex items-center gap-0.5">
                          <span className="h-1.5 w-1.5 bg-amber-500 rounded-full" />
                          Husk: {huskPct.toFixed(0)}%
                        </span>
                        <span className="flex items-center gap-0.5">
                          <span className="h-1.5 w-1.5 bg-stone-500 rounded-full" />
                          Waste: {wastePct.toFixed(0)}%
                        </span>
                        <span className="flex items-center gap-0.5">
                          <span className="h-1.5 w-1.5 bg-red-400 rounded-full" />
                          Loss: {lostPct.toFixed(0)}%
                        </span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-bold text-indigo-600">{kg(it.pappuWeightKg)}</TableCell>
                  <TableCell>
                    {it.pappuPrice ? (
                      <Badge variant="outline">{rupees(it.pappuPrice.pricePerKg)}/kg</Badge>
                    ) : (
                      <Badge variant="secondary">Unpriced</Badge>
                    )}
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
