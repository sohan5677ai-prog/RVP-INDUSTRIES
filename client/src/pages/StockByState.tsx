import { useQuery } from '@tanstack/react-query';
import { Loader2, Landmark, AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
import { kg, rupees, toTonnes } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';

interface StateStock {
  state: string;
  totalPurchasedKg: number;
  totalMilledKg: number;
  netStockKg: number;
  totalValue: number;
  supplierCount: number;
}

const STATE_STOCK_COLUMNS: ExportColumn<StateStock>[] = [
  { header: 'State', value: (s) => s.state },
  { header: 'Suppliers', value: (s) => s.supplierCount, align: 'right' },
  { header: 'Total Sourced (t)', value: (s) => toTonnes(s.totalPurchasedKg).toFixed(2), excel: (s) => toTonnes(s.totalPurchasedKg), numFmt: '#,##0.00', align: 'right' },
  { header: 'Milled (t)', value: (s) => toTonnes(s.totalMilledKg).toFixed(2), excel: (s) => toTonnes(s.totalMilledKg), numFmt: '#,##0.00', align: 'right' },
  { header: 'Net Stock (t)', value: (s) => toTonnes(s.netStockKg).toFixed(2), excel: (s) => toTonnes(s.netStockKg), numFmt: '#,##0.00', align: 'right' },
  { header: 'Total Value', value: (s) => rupees(s.totalValue), excel: (s) => s.totalValue, numFmt: '#,##0.00', align: 'right' },
];

export default function StockByState() {
  const { data: stateStocks, isLoading } = useQuery<StateStock[]>({
    queryKey: ['state-stocks'],
    queryFn: () => api<StateStock[]>('/inventory/by-state'),
  });

  const totalRemaining = stateStocks?.reduce((sum, s) => sum + s.netStockKg, 0) ?? 0;
  const totalValueSum = stateStocks?.reduce((sum, s) => sum + s.totalValue, 0) ?? 0;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Stock by State</h1>
          <p className="text-muted-foreground">
            Geographic inventory breakdown and sourcing patterns by supplier state
          </p>
        </div>
        <ExportButtons
          filename="Stock_By_State"
          title="Stock by State"
          subtitle={`${stateStocks?.length ?? 0} state(s)`}
          columns={STATE_STOCK_COLUMNS}
          rows={stateStocks ?? []}
        />
      </div>

      {stateStocks?.length === 0 ? (
        <Card className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
          <AlertTriangle className="h-10 w-10 text-amber-500 mb-2" />
          <h3 className="font-semibold text-lg">No Geographic Data</h3>
          <p className="text-sm max-w-md mt-1">
            There are no supplier states to display. State names are parsed from supplier address fields.
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {stateStocks?.map((s) => {
            const stockPct = totalRemaining > 0 ? (s.netStockKg / totalRemaining) * 100 : 0;
            const valPct = totalValueSum > 0 ? (s.totalValue / totalValueSum) * 100 : 0;
            const millPct = s.totalPurchasedKg > 0 ? (s.totalMilledKg / s.totalPurchasedKg) * 100 : 0;

            return (
              <Card key={s.state} className="flex flex-col bg-card hover:-translate-y-0.5 transition-all duration-200">
                <CardHeader className="pb-3 border-b border-muted/50 bg-muted/5">
                  <div className="flex justify-between items-center gap-2">
                    <CardTitle className="flex items-center gap-2 text-base font-bold text-primary">
                      <Landmark className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="truncate">{s.state}</span>
                    </CardTitle>
                    <Badge variant="secondary" className="text-xs font-semibold px-2.5 py-0.5 shrink-0">
                      {s.supplierCount} {s.supplierCount === 1 ? 'Supplier' : 'Suppliers'}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="pt-4 space-y-4 flex-1 flex flex-col">
                  {/* Net stock + geographic share */}
                  <div>
                    <div className="flex items-baseline justify-between">
                      <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                        Net Stock
                      </span>
                      <span className="text-xs text-muted-foreground">{stockPct.toFixed(0)}% of total volume</span>
                    </div>
                    <div className="text-2xl font-bold tracking-tight text-primary mt-1">
                      {toTonnes(s.netStockKg).toFixed(2)} MT
                    </div>
                    <div className="flex justify-between items-center mt-1">
                      <span className="text-[10px] text-muted-foreground font-mono">({kg(s.netStockKg)})</span>
                      <span className="text-xs font-semibold text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded">{valPct.toFixed(1)}% of total cost</span>
                    </div>
                    <div className="h-2 w-full bg-muted rounded-full overflow-hidden mt-2">
                      <div
                        className="h-full bg-primary transition-all duration-500"
                        style={{ width: `${stockPct}%` }}
                        title={`${stockPct.toFixed(1)}% share`}
                      />
                    </div>
                  </div>

                  {/* Total sourced */}
                  <div className="flex items-baseline justify-between">
                    <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                      Total Sourced
                    </span>
                    <span className="text-sm font-semibold text-foreground">
                      {toTonnes(s.totalPurchasedKg).toFixed(2)} MT
                    </span>
                  </div>

                  {/* Milling progress */}
                  <div className="space-y-1.5 pt-2 border-t border-dashed mt-auto">
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-muted-foreground">Milled Ratio</span>
                      <span className="font-semibold text-blue-600">{millPct.toFixed(0)}%</span>
                    </div>
                    <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-500 transition-all duration-500"
                        style={{ width: `${millPct}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-[10px] text-muted-foreground">
                      <span>Milled: {toTonnes(s.totalMilledKg).toFixed(1)} MT</span>
                      <span>Pending: {toTonnes(s.netStockKg).toFixed(1)} MT</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
