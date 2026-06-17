import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, Loader2, Warehouse, Scale, Play, CheckCircle2, AlertCircle } from 'lucide-react';
import { api } from '@/lib/api';
import type { StockIn, Processing } from '@/lib/types';
import { kg, shortDate } from '@/lib/format';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';

type LocationType = 'At process' | 'Rampalli' | 'Murgan' | 'Multi';

export default function StockLocation() {
  const [selectedLoc, setSelectedLoc] = useState<LocationType>('At process');
  const [searchQuery, setSearchQuery] = useState('');

  const { data: stockIns, isLoading: loadingStock } = useQuery({
    queryKey: ['stock-in'],
    queryFn: () => api<StockIn[]>('/stock-in'),
  });

  const { data: processingRuns, isLoading: loadingProc } = useQuery({
    queryKey: ['processing'],
    queryFn: () => api<Processing[]>('/processing'),
  });

  const locations: LocationType[] = ['At process', 'Rampalli', 'Murgan', 'Multi'];

  // Calculate inventory metrics for each location
  const metrics = locations.reduce((acc, loc) => {
    // 1. Filter Stock-ins for this location
    const locStockIns = stockIns?.filter((s) => (s.loadingLocation || 'At process') === loc) ?? [];

    // Arrived = Purchased Net Weight, or Billing Weight if pending purchase
    const arrivedKg = locStockIns.reduce((sum, s) => {
      if (s.purchase) {
        return sum + s.purchase.netWeightKg;
      }
      return sum + s.billingWeightKg;
    }, 0);

    // 2. Processed = black weight from processing runs linked to this location's purchases
    // Standalone processing runs (no purchaseId) default to "At process"
    const processedKg = processingRuns?.filter((p) => {
      if (p.purchase) {
        return (p.purchase.stockIn?.loadingLocation || 'At process') === loc;
      }
      return loc === 'At process';
    }).reduce((sum, p) => sum + p.blackWeightKg, 0) ?? 0;

    const availableKg = Math.max(0, arrivedKg - processedKg);

    acc[loc] = {
      arrivedKg,
      processedKg,
      availableKg,
      stockIns: locStockIns,
    };
    return acc;
  }, {} as Record<LocationType, { arrivedKg: number; processedKg: number; availableKg: number; stockIns: StockIn[] }>);

  const active = metrics[selectedLoc] || { arrivedKg: 0, processedKg: 0, availableKg: 0, stockIns: [] };

  // Filter detail list of stock-ins at active location by search query
  const filteredStockIns = active.stockIns.filter((s) => {
    const term = searchQuery.toLowerCase();
    const lorryMatch = s.lorryNumber.toLowerCase().includes(term);
    const invoiceMatch = s.invoiceNumber.toLowerCase().includes(term);
    const supplierMatch = s.purchaseOrder?.party?.name?.toLowerCase().includes(term) ?? false;
    const poMatch = s.purchaseOrder?.poNumber?.toLowerCase().includes(term) ?? false;
    return lorryMatch || invoiceMatch || supplierMatch || poMatch;
  });

  const isLoading = loadingStock || loadingProc;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Stock by Location</h1>
        <p className="text-muted-foreground">Manage and track tamarind seed inventory across warehouses and process mills</p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : (
        <div className="grid gap-6">
          {/* Warehouse Location Cards Grid */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {locations.map((loc) => {
              const item = metrics[loc];
              const isSelected = selectedLoc === loc;
              const pct = item.arrivedKg > 0 ? (item.processedKg / item.arrivedKg) * 100 : 0;

              return (
                <button
                  key={loc}
                  onClick={() => setSelectedLoc(loc)}
                  className={`text-left rounded-xl border p-5 transition-all duration-200 ${
                    isSelected
                      ? 'border-primary ring-1 ring-primary bg-primary/[0.02] shadow-sm'
                      : 'bg-card hover:border-primary/40 hover:-translate-y-0.5 hover:shadow-sm'
                  }`}
                >
                  <div className="flex items-center justify-between mb-3">
                    <span className="font-semibold text-sm">{loc}</span>
                    <Warehouse className={`h-4 w-4 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`} />
                  </div>
                  <div className="space-y-1.5">
                    <div className="text-2xl font-bold tracking-tight text-primary">
                      {kg(item.availableKg)}
                    </div>
                    <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">
                      Available Stock
                    </div>
                  </div>

                  {/* Micro Process Visualization Bar */}
                  <div className="mt-4 space-y-1">
                    <div className="flex justify-between text-[10px] text-muted-foreground">
                      <span>Milled: {pct.toFixed(0)}%</span>
                      <span>{kg(item.arrivedKg)} total</span>
                    </div>
                    <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary transition-all duration-500"
                        style={{ width: `${Math.min(100, pct)}%` }}
                      />
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Audit Detail Table */}
          <div className="rounded-xl border bg-card">
            <div className="px-5 py-4 border-b flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-muted/10 rounded-t-xl">
              <div>
                <span className="font-semibold text-sm">
                  Inventory details at: <span className="text-primary font-bold">{selectedLoc}</span>
                </span>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Showing arrived lorries and milling statuses for {selectedLoc}
                </p>
              </div>
              <div className="relative w-64">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search lorry or supplier…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9 bg-card"
                />
              </div>
            </div>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Arrival Date</TableHead>
                  <TableHead>PO Reference</TableHead>
                  <TableHead>Supplier</TableHead>
                  <TableHead>Invoice & Lorry</TableHead>
                  <TableHead className="text-right">Arrived Weight</TableHead>
                  <TableHead>Purchase Status</TableHead>
                  <TableHead>Milling Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredStockIns.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                      No stock arrivals found at this location.
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredStockIns.map((s) => {
                    // Check if there is an associated processing run
                    const isMilled = processingRuns?.some((p) => p.purchaseId === s.purchase?.id);
                    const isPurchased = !!s.purchase;

                    // Compute weight description
                    const arrivedWeightVal = s.purchase ? s.purchase.netWeightKg : s.billingWeightKg;

                    return (
                      <TableRow key={s.id}>
                        <TableCell>{shortDate(s.arrivalDate)}</TableCell>
                        <TableCell className="font-mono text-xs font-semibold">
                          {s.purchaseOrder?.poNumber ?? '—'}
                        </TableCell>
                        <TableCell className="font-medium">
                          {s.purchaseOrder?.party?.name ?? '—'}
                        </TableCell>
                        <TableCell>
                          <div className="text-sm font-medium">Inv {s.invoiceNumber}</div>
                          <div className="text-xs text-muted-foreground font-mono">{s.lorryNumber}</div>
                        </TableCell>
                        <TableCell className="text-right font-semibold">
                          {kg(arrivedWeightVal)}
                          {!isPurchased && (
                            <span className="block text-[10px] text-muted-foreground italic">(Billing Wt)</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {isPurchased ? (
                            <Badge variant="outline" className="border-green-500/30 text-green-600 bg-green-50/50 dark:bg-green-950/10">
                              <CheckCircle2 className="h-3 w-3 mr-1 inline" /> Purchased
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="border-amber-500/30 text-amber-600 bg-amber-50/50 dark:bg-amber-950/10 animate-pulse">
                              <AlertCircle className="h-3 w-3 mr-1 inline" /> Pending
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {isMilled ? (
                            <Badge variant="default">
                              <Scale className="h-3 w-3 mr-1 inline" /> Milled
                            </Badge>
                          ) : (
                            <Badge variant="secondary">
                              <Play className="h-3 w-3 mr-1 inline" /> In Stock
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
