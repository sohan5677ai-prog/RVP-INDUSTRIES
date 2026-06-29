import { useQuery } from '@tanstack/react-query';
import { 
  AlertCircle, 
  CheckCircle2, 
  Clock, 
  Info,
  AlertTriangle,
  PieChart
} from 'lucide-react';
import { api } from '@/lib/api';
import { toTonnes, kg, shortDate } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';

interface Allocation {
  id: string;
  saleOrderId: string;
  buyer: string;
  weightKg: number;
  status: 'SOFT' | 'HARD' | 'BUMPED';
  saleDate: string;
}

interface POHealth {
  poId: string;
  poNumber: string;
  party: string;
  status: string;
  originalTonnageKg: number;
  actualTonnageKg: number | null;
  effectiveTonnageKg: number;
  varianceKg: number | null;
  variancePct: number | null;
  expectedPappuKg: number;
  allowedPappuKg: number;
  softAllocatedKg: number;
  hardAllocatedKg: number;
  bumpedAllocatedKg: number;
  totalAllocatedKg: number;
  uncommittedKg: number;
  utilizationPct: number;
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  allocations: Allocation[];
}

interface UnallocatedSale {
  saleOrderId: string;
  buyer: string;
  saleDate: string;
  orderedKg: number;
  allocatedKg: number;
  unallocatedKg: number;
}

interface HealthSummary {
  totalSoftKg: number;
  totalHardKg: number;
  totalBumpedKg: number;
  totalCommittedKg: number;
  criticalPOs: number;
  highRiskPOs: number;
  unallocatedSaleOrders: number;
  bufferStockPct: number;
}

interface AllocationHealthResponse {
  summary: HealthSummary;
  purchaseOrders: POHealth[];
  unallocatedSales: UnallocatedSale[];
}

export default function AllocationHealth() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['allocation-health'],
    queryFn: () => api<AllocationHealthResponse>('/allocation-health'),
    refetchInterval: 60000, // refresh every minute
  });

  if (isLoading) {
    return <div className="p-8 text-center text-muted-foreground animate-pulse">Loading Allocation Health...</div>;
  }

  if (error || !data) {
    return (
      <div className="p-8 text-center text-red-500">
        Error loading allocation health dashboard. {String(error)}
      </div>
    );
  }

  const { summary, purchaseOrders, unallocatedSales } = data;

  const getRiskColor = (risk: string) => {
    switch (risk) {
      case 'CRITICAL': return 'bg-red-500/10 text-red-500 hover:bg-red-500/20';
      case 'HIGH': return 'bg-amber-500/10 text-amber-500 hover:bg-amber-500/20';
      case 'MEDIUM': return 'bg-yellow-500/10 text-yellow-500 hover:bg-yellow-500/20';
      default: return 'bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20';
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'HARD': return <Badge variant="outline" className="border-emerald-500/30 text-emerald-500 bg-emerald-500/10">HARD</Badge>;
      case 'SOFT': return <Badge variant="outline" className="border-blue-500/30 text-blue-500 bg-blue-500/10">SOFT</Badge>;
      case 'BUMPED': return <Badge variant="outline" className="border-amber-500/30 text-amber-500 bg-amber-500/10">BUMPED</Badge>;
      default: return <Badge variant="outline">{status}</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-display font-semibold text-foreground tracking-tight">Commitment Health Monitor</h1>
        <p className="text-muted-foreground mt-2">Real-time advance allocation tracking and PO risk analysis.</p>
      </div>

      {/* Summary Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="bg-card/50 border-white/5 backdrop-blur-xl">
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Committed</CardTitle>
            <PieChart className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">{toTonnes(summary.totalCommittedKg)}</div>
            <p className="text-xs text-muted-foreground mt-1">Total Pappu weight promised</p>
          </CardContent>
        </Card>

        <Card className="bg-card/50 border-white/5 backdrop-blur-xl">
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-medium text-muted-foreground">Hard / Soft Split</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="flex items-end justify-between">
              <div>
                <div className="text-2xl font-bold font-mono text-emerald-500">{toTonnes(summary.totalHardKg)}</div>
                <p className="text-xs text-muted-foreground mt-1">Confirmed (Hard)</p>
              </div>
              <div className="text-right">
                <div className="text-xl font-bold font-mono text-blue-500">{toTonnes(summary.totalSoftKg)}</div>
                <p className="text-xs text-muted-foreground mt-1">Pending (Soft)</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card/50 border-white/5 backdrop-blur-xl">
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-medium text-muted-foreground">At-Risk POs</CardTitle>
            <AlertTriangle className={`h-4 w-4 ${summary.criticalPOs > 0 ? 'text-red-500 animate-pulse' : 'text-amber-500'}`} />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono text-red-500">{summary.criticalPOs} Critical</div>
            <p className="text-xs text-muted-foreground mt-1">{summary.highRiskPOs} High Risk (Over {summary.bufferStockPct}% allocated)</p>
          </CardContent>
        </Card>

        <Card className="bg-card/50 border-white/5 backdrop-blur-xl">
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-medium text-muted-foreground">Unallocated Sales</CardTitle>
            <AlertCircle className={`h-4 w-4 ${summary.unallocatedSaleOrders > 0 ? 'text-amber-500' : 'text-muted-foreground'}`} />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">{summary.unallocatedSaleOrders} Orders</div>
            <p className="text-xs text-muted-foreground mt-1">Require PO capacity to fulfill</p>
          </CardContent>
        </Card>
      </div>

      {/* Unallocated / Orphaned Sales Warning */}
      {unallocatedSales.length > 0 && (
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardHeader>
            <CardTitle className="text-amber-500 flex items-center gap-2">
              <AlertTriangle className="h-5 w-5" />
              Unallocated Sale Orders (Orphaned / Short PO Capacity)
            </CardTitle>
            <CardDescription className="text-amber-500/70">
              These orders do not have enough Purchase Order capacity backing them up. You need to create more POs.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow className="border-amber-500/20 hover:bg-transparent">
                  <TableHead className="text-amber-500/70">Sale Order ID</TableHead>
                  <TableHead className="text-amber-500/70">Buyer</TableHead>
                  <TableHead className="text-amber-500/70">Date</TableHead>
                  <TableHead className="text-right text-amber-500/70">Ordered</TableHead>
                  <TableHead className="text-right text-amber-500/70">Allocated</TableHead>
                  <TableHead className="text-right text-amber-500/70">Unallocated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {unallocatedSales.map(sale => (
                  <TableRow key={sale.saleOrderId} className="border-amber-500/10 hover:bg-amber-500/5">
                    <TableCell className="font-mono text-xs">{sale.saleOrderId}</TableCell>
                    <TableCell>{sale.buyer}</TableCell>
                    <TableCell>{shortDate(sale.saleDate)}</TableCell>
                    <TableCell className="text-right">{toTonnes(sale.orderedKg)}</TableCell>
                    <TableCell className="text-right text-emerald-500">{toTonnes(sale.allocatedKg)}</TableCell>
                    <TableCell className="text-right text-amber-500 font-bold">{toTonnes(sale.unallocatedKg)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Pending POs Exposure */}
      <Card className="bg-card/50 border-white/5 backdrop-blur-xl">
        <CardHeader>
          <CardTitle>PO Capacity & Exposure</CardTitle>
          <CardDescription>
            Live view of how much Pappu from each PO is committed to customers.
            Buffer capacity is capped at {summary.bufferStockPct}%.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="border-white/10 hover:bg-transparent">
                <TableHead>PO Number</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Variance</TableHead>
                <TableHead className="text-right">Tonnage</TableHead>
                <TableHead className="text-right">Expected Pappu</TableHead>
                <TableHead className="text-right">Committed</TableHead>
                <TableHead className="text-right">Uncommitted</TableHead>
                <TableHead>Risk</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {purchaseOrders.length === 0 ? (
                <TableRow className="border-white/5 hover:bg-white/5">
                  <TableCell colSpan={8} className="text-center py-6 text-muted-foreground">
                    No active Purchase Orders found.
                  </TableCell>
                </TableRow>
              ) : (
                purchaseOrders.map((po) => (
                  <TableRow key={po.poId} className="border-white/5 hover:bg-white/5">
                    <TableCell>
                      <div className="font-medium text-foreground">{po.poNumber}</div>
                      <div className="text-xs text-muted-foreground">{po.party}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={po.status === 'ARRIVED' ? 'border-emerald-500/30 text-emerald-500' : 'border-blue-500/30 text-blue-500'}>
                        {po.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {po.variancePct !== null ? (
                        <span className={po.variancePct < 0 ? 'text-red-500' : po.variancePct > 0 ? 'text-emerald-500' : 'text-muted-foreground'}>
                          {po.variancePct > 0 ? '+' : ''}{po.variancePct}%
                          {Math.abs(po.variancePct) > 2 ? ' ⚠️' : ''}
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-xs italic">Pending</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {toTonnes(po.effectiveTonnageKg)}
                      {po.actualTonnageKg && po.actualTonnageKg !== po.originalTonnageKg && (
                        <div className="text-xs text-muted-foreground line-through">
                          ({toTonnes(po.originalTonnageKg)})
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground">
                      {toTonnes(po.expectedPappuKg)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-emerald-500">
                      {toTonnes(po.totalAllocatedKg)}
                      <div className="text-[10px] text-muted-foreground">
                        {po.utilizationPct.toFixed(1)}% of cap
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono font-medium">
                      <span className={po.uncommittedKg < 0 ? 'text-red-500' : 'text-foreground'}>
                        {toTonnes(po.uncommittedKg)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={getRiskColor(po.risk)}>
                        {po.risk}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      
      {/* Detailed Allocations */}
      <Card className="bg-card/50 border-white/5 backdrop-blur-xl mt-6">
        <CardHeader>
          <CardTitle>Detailed Commitments</CardTitle>
          <CardDescription>
            Every single allocation mapping a sale order to a PO.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="border-white/10 hover:bg-transparent">
                <TableHead>PO Number</TableHead>
                <TableHead>Sale Order</TableHead>
                <TableHead>Buyer</TableHead>
                <TableHead>Sale Date</TableHead>
                <TableHead className="text-right">Committed Wt</TableHead>
                <TableHead>Phase</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {purchaseOrders.flatMap(po => po.allocations.map(alloc => ({ po, alloc }))).length === 0 ? (
                <TableRow className="border-white/5 hover:bg-white/5">
                  <TableCell colSpan={6} className="text-center py-6 text-muted-foreground">
                    No active allocations found.
                  </TableCell>
                </TableRow>
              ) : (
                purchaseOrders.flatMap(po => po.allocations.map(alloc => (
                  <TableRow key={alloc.id} className="border-white/5 hover:bg-white/5">
                    <TableCell className="font-medium">{po.poNumber}</TableCell>
                    <TableCell className="font-mono text-xs">{alloc.saleOrderId}</TableCell>
                    <TableCell>{alloc.buyer}</TableCell>
                    <TableCell>{shortDate(alloc.saleDate)}</TableCell>
                    <TableCell className="text-right font-mono">{kg(alloc.weightKg)}</TableCell>
                    <TableCell>{getStatusBadge(alloc.status)}</TableCell>
                  </TableRow>
                )))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
