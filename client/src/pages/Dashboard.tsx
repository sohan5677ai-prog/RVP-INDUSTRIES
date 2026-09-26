import { lazy, Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ClipboardList, Truck, Boxes, Wheat, Wallet, ShoppingCart,
  Gauge, AlertTriangle,
} from 'lucide-react';
import { api } from '@/lib/api';
import { kg, rupees } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import FestivalCalendarWidget from '@/components/FestivalCalendarWidget';
import type { ProfitLoss } from '@/lib/types';
import type { Summary, HuskPnl, DashboardMetrics } from './DashboardCharts';

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

  const { data, isLoading, error, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['dashboard'],
    queryFn: ({ signal }) => api<Summary>('/dashboard/summary', { signal }),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  // Management P&L - the Profitability card mirrors the Profit & Loss A/c page
  // so the dashboard and the report never quote two different net profits.
  // Key matches ProfitLoss.tsx so both share one cached fetch.
  const profitQuery = useQuery({
    queryKey: ['profit-loss'],
    queryFn: ({ signal }) => api<ProfitLoss>('/reports/profit-loss', { signal }),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const charts = useQuery({
    queryKey: ['dashboard', 'charts'],
    queryFn: ({ signal }) => api<DashboardMetrics>('/dashboard/charts', { signal }),
  });
  const huskQuery = useQuery({
    queryKey: ['husk-pnl'],
    queryFn: ({ signal }) => api<HuskPnl>('/reports/husk-pnl', { signal }),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });



  const refresh = () => Promise.all([refetch(), charts.refetch(), profitQuery.refetch(), huskQuery.refetch()]);
  const refreshing = isFetching || charts.isFetching || profitQuery.isFetching || huskQuery.isFetching;
  const chartError = charts.error || profitQuery.error || huskQuery.error;

  return (
    <div className="space-y-7">
      <PageHeader
        icon={Gauge}
        title="Dashboard"
        description="Live view of procurement, stock, sales pipeline and profitability."
      />

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{dataUpdatedAt ? `Updated ${new Date(dataUpdatedAt).toLocaleTimeString()}` : 'Loading dashboard'}</span>
        <Button variant="outline" size="sm" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? 'Refreshing…' : 'Refresh'}</Button>
      </div>
      {error && <div role="alert" className="rounded-xl border border-destructive/30 p-4 text-sm text-destructive">
        <AlertTriangle className="mr-2 inline h-4 w-4" />{error.message}
        {data && <span> Showing the last available figures.</span>}
        <Button variant="outline" size="sm" className="ml-3" disabled={refreshing} onClick={() => void refresh()}>Retry</Button>
      </div>}
      {isLoading ? (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-28 rounded-2xl border border-border shimmer" />
          ))}
        </div>
      ) : data ? (
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

          {/* Festival & Holiday Reminder Calendar */}
          <FestivalCalendarWidget />

          {chartError && <div role="alert" className="rounded-xl border border-destructive/30 p-4 text-sm text-destructive">
            Some dashboard reports could not be refreshed. {chartError.message}
            <Button variant="outline" size="sm" className="ml-3" disabled={refreshing} onClick={() => void refresh()}>Retry</Button>
          </div>}
          {charts.data && profitQuery.data && huskQuery.data ? (
            <Suspense fallback={<ChartsSkeleton />}>
              <DashboardCharts data={data} pnl={profitQuery.data} metrics={charts.data} huskPnl={huskQuery.data} />
            </Suspense>
          ) : !chartError ? <ChartsSkeleton /> : null}
        </div>
      ) : null}


    </div>
  );
}
