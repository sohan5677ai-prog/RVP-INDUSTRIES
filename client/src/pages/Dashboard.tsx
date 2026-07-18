import { lazy, Suspense } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ClipboardList, Truck, Boxes, Wheat, Wallet, ShoppingCart,
  Gauge, AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { kg, rupees } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import type { Account, PurchaseOrder, SaleOrder } from '@/lib/types';
import type { Summary, HuskPnl, PurchaseRow } from './DashboardCharts';

// Charts pull in recharts (~300 kB). Splitting them into a lazy chunk lets the
// page shell + KPI cards paint immediately on navigation; the charts stream in
// behind a skeleton instead of blocking the whole route on the recharts parse.
const DashboardCharts = lazy(() => import('./DashboardCharts'));

function ChartsSkeleton() {
  return (
    <div className="space-y-7">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 h-[318px] rounded-2xl border border-border shimmer" />
        <div className="h-[318px] rounded-2xl border border-border shimmer" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-[278px] rounded-2xl border border-border shimmer" />
        ))}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({ queryKey: ['dashboard'], queryFn: () => api<Summary>('/dashboard/summary') });
  const { data: accounts } = useQuery({ queryKey: ['ledger-accounts'], queryFn: () => api<Account[]>('/ledger/accounts') });
  const { data: purchases } = useQuery({ queryKey: ['purchases'], queryFn: () => api<PurchaseRow[]>('/purchases?all=true') });
  const { data: poAll } = useQuery({ queryKey: ['purchase-orders', 'ALL'], queryFn: () => api<PurchaseOrder[]>('/purchase-orders?all=true') });
  const { data: saleAll } = useQuery({ queryKey: ['sale-orders', 'ALL'], queryFn: () => api<SaleOrder[]>('/sale-orders') });
  const { data: huskPnl } = useQuery({ queryKey: ['husk-pnl'], queryFn: () => api<HuskPnl>('/reports/husk-pnl') });

  const resetMutation = useMutation({
    mutationFn: () => api<{ message: string }>('/system/clear-transactions', { method: 'POST' }),
    onSuccess: (res) => { qc.invalidateQueries(); toast.success(res.message || 'ERP transactional data reset successfully!'); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-7">
      <PageHeader
        icon={Gauge}
        title="Dashboard"
        description="Live view of procurement, stock, sales pipeline and profitability."
      />

      {isLoading || !data ? (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-28 rounded-2xl border border-border shimmer" />
          ))}
        </div>
      ) : (
        <div className="space-y-7">
          {/* KPI row */}
          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4 stagger">
            <StatCard label="Pending POs" value={data.pendingPOs} icon={ClipboardList} tone="clay" hint="awaiting arrival" />
            <StatCard label="Arriving" value={data.arrivedPOs} icon={Truck} tone="gold" hint="in pipeline" />
            <StatCard label="Black stock" value={kg(data.blackStockOnHandKg)} icon={Boxes} tone="amber" hint="on hand" />
            <StatCard label="Pappu inv." value={kg(data.pappuInventoryKg)} icon={Wheat} tone="forest" hint="produced − sold" />
            <StatCard label="Pending sales" value={data.pendingSales} icon={ShoppingCart} tone="rose" hint="awaiting dispatch" />
            <StatCard label="Payable" value={rupees(data.supplierPayable)} icon={Wallet} tone="taupe" hint="to suppliers" />
          </div>

          <Suspense fallback={<ChartsSkeleton />}>
            <DashboardCharts data={data} accounts={accounts} purchases={purchases} poAll={poAll} saleAll={saleAll} huskPnl={huskPnl} />
          </Suspense>
        </div>
      )}

      {/* Danger zone */}
      <div className="pt-2">
        <Card className="border-destructive/30 bg-destructive/[0.02]">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-semibold text-destructive uppercase tracking-wider flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" /> Danger zone
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold">Reset ERP transactional data</p>
              <p className="text-xs text-muted-foreground mt-0.5 max-w-2xl">
                Permanently clears all purchase orders, arrivals, weight verifications, ledger statements, and processing batches. Master data (Parties, Brokers, Users) is preserved.
              </p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              disabled={resetMutation.isPending}
              onClick={() => {
                if (confirm('CRITICAL WARNING: This will permanently delete all transaction records and restart your ledgers from zero. Are you sure you want to proceed?')) {
                  resetMutation.mutate();
                }
              }}
            >
              {resetMutation.isPending ? 'Resetting…' : 'Reset ERP data'}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
