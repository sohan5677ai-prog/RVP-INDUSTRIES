import { useQuery } from '@tanstack/react-query';
import { Loader2, Globe, Landmark, AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
import { kg, toTonnes } from '@/lib/format';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface StateStock {
  state: string;
  totalPurchasedKg: number;
  totalMilledKg: number;
  netStockKg: number;
  supplierCount: number;
}

export default function StockByState() {
  const { data: stateStocks, isLoading } = useQuery<StateStock[]>({
    queryKey: ['state-stocks'],
    queryFn: () => api<StateStock[]>('/inventory/by-state'),
  });

  const totalRemaining = stateStocks?.reduce((sum, s) => sum + s.netStockKg, 0) ?? 0;
  const totalPurchased = stateStocks?.reduce((sum, s) => sum + s.totalPurchasedKg, 0) ?? 0;

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
        <h1 className="text-2xl font-bold">Stock by State</h1>
        <p className="text-muted-foreground">
          Geographic inventory breakdown and sourcing patterns by supplier state
        </p>
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
        <div className="grid gap-6">
          {/* Geographic Distribution Analytics Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Globe className="h-5 w-5 text-primary" />
                <span>Geographic Stock Share</span>
              </CardTitle>
              <CardDescription>
                Overview of current warehouse inventory contribution by sourcing region
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-4">
                {stateStocks?.map((s) => {
                  const purchasedPct = totalPurchased > 0 ? (s.totalPurchasedKg / totalPurchased) * 100 : 0;
                  const stockPct = totalRemaining > 0 ? (s.netStockKg / totalRemaining) * 100 : 0;

                  return (
                    <div key={s.state} className="space-y-2">
                      <div className="flex justify-between items-center text-sm font-medium">
                        <div className="flex items-center gap-2">
                          <Landmark className="h-4 w-4 text-muted-foreground" />
                          <span>{s.state}</span>
                          <span className="text-xs text-muted-foreground font-normal">
                            ({s.supplierCount} {s.supplierCount === 1 ? 'supplier' : 'suppliers'})
                          </span>
                        </div>
                        <div className="text-right">
                          <span className="text-primary font-semibold">{toTonnes(s.netStockKg).toFixed(1)} MT remaining </span>
                          <span className="text-xs text-muted-foreground">({stockPct.toFixed(0)}% share)</span>
                        </div>
                      </div>

                      {/* Stacked indicators */}
                      <div className="space-y-1">
                        <div className="h-2.5 w-full bg-muted rounded-full overflow-hidden flex">
                          <div
                            className="h-full bg-primary transition-all duration-500"
                            style={{ width: `${stockPct}%` }}
                            title={`Stock: ${stockPct.toFixed(1)}%`}
                          />
                        </div>
                        <div className="flex justify-between text-[10px] text-muted-foreground">
                          <span>Sourcing Purchase Share: {purchasedPct.toFixed(1)}%</span>
                          <span>Total Sourced: {toTonnes(s.totalPurchasedKg).toFixed(1)} MT</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* Cards Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {stateStocks?.map((s) => {
              const millPct = s.totalPurchasedKg > 0 ? (s.totalMilledKg / s.totalPurchasedKg) * 100 : 0;

              return (
                <Card key={s.state} className="bg-card hover:-translate-y-0.5 transition-all duration-200">
                  <CardHeader className="pb-3 border-b border-muted/50 bg-muted/5">
                    <div className="flex justify-between items-center">
                      <CardTitle className="text-base font-bold text-primary">{s.state}</CardTitle>
                      <Badge variant="secondary" className="text-xs font-semibold px-2.5 py-0.5">
                        {s.supplierCount} {s.supplierCount === 1 ? 'Supplier' : 'Suppliers'}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="pt-4 space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                          Net Stock
                        </div>
                        <div className="text-lg font-bold tracking-tight text-primary mt-1">
                          {toTonnes(s.netStockKg).toFixed(2)} MT
                        </div>
                        <span className="text-[10px] text-muted-foreground font-mono">({kg(s.netStockKg)})</span>
                      </div>
                      <div className="text-right">
                        <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                          Total Sourced
                        </div>
                        <div className="text-lg font-bold tracking-tight text-foreground mt-1">
                          {toTonnes(s.totalPurchasedKg).toFixed(2)} MT
                        </div>
                        <span className="text-[10px] text-muted-foreground font-mono">({kg(s.totalPurchasedKg)})</span>
                      </div>
                    </div>

                    {/* Lorry Milling Progress */}
                    <div className="space-y-1.5 pt-2 border-t border-dashed">
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
        </div>
      )}
    </div>
  );
}
