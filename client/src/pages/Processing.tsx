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
              <TableHead className="text-right">Black (kg)</TableHead>
              <TableHead className="text-right">Out-turn</TableHead>
              <TableHead className="text-right">Pappu (kg)</TableHead>
              <TableHead>Pricing</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">Loading…</TableCell></TableRow>
            )}
            {!isLoading && items?.length === 0 && (
              <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No processing batches yet. Approve a purchase on the Verification page to mill it.</TableCell></TableRow>
            )}
            {items?.map((it) => (
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
                <TableCell className="text-right font-semibold">
                  <div>{kg(it.pappuWeightKg)}</div>
                  <div className="text-[10px] text-muted-foreground font-normal mt-0.5">
                    Husk: {kg(it.huskWeightKg)} · Waste: {kg(it.wasteWeightKg)}
                  </div>
                </TableCell>
                <TableCell>
                  {it.pappuPrice ? (
                    <Badge variant="outline">{rupees(it.pappuPrice.pricePerKg)}/kg</Badge>
                  ) : (
                    <Badge variant="secondary">Unpriced</Badge>
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
