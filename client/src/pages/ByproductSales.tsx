import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { Recycle, Package, ArrowRight } from 'lucide-react';
import { api } from '@/lib/api';
import { kg, toTonnes } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import SalesProduct from './SalesProduct';
import PreCleanerDust from './PreCleanerDust';

// The 10% "Pre Cleaner Husk & Tamarind" pool: 10% of every black-seed arrival.
// Shell, Waste and the three pre-cleaner byproducts are ALL sold from this one
// shared pool - each dispatch draws it down.
const WASTE_PCT = 0.1;

interface BlackSeedStockResponse {
  wastePoolSoldKg: number;
}
interface PriceBand { arrivedBlackKg: number; pendingBlackKg: number }
interface StockByPriceResponse { bands: PriceBand[] }

/** Which tab to open first, based on the route the user arrived from. */
function defaultTabFor(pathname: string): string {
  if (pathname.includes('waste')) return 'waste';
  return 'precleaner-dust';
}

export default function ByproductSales() {
  const { pathname } = useLocation();
  const [tab, setTab] = useState(() => defaultTabFor(pathname));

  const { data: stock } = useQuery({
    queryKey: ['black-seed-stock'],
    queryFn: () => api<BlackSeedStockResponse>('/inventory/black-seed'),
  });
  const { data: planner } = useQuery({
    queryKey: ['stock-by-price'],
    queryFn: () => api<StockByPriceResponse>('/inventory/by-price'),
  });

  const bands = planner?.bands ?? [];
  const arrivedKg = bands.reduce((s, b) => s + b.arrivedBlackKg, 0);
  const pendingKg = bands.reduce((s, b) => s + b.pendingBlackKg, 0);
  const soldKg = stock?.wastePoolSoldKg ?? 0;

  const poolTotalKg = Math.round(WASTE_PCT * arrivedKg);
  const availableKg = Math.max(0, poolTotalKg - soldKg);
  const committedKg = availableKg + Math.round(WASTE_PCT * pendingKg);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Recycle}
        title="Tamarind Byproducts"
        description="Waste and the pre-cleaner byproducts all sell from the single 10% pool. Every sale here draws that pool down."
      />

      {/* Shared 10% pool - depleted by all five byproducts below */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 stagger">
        <StatCard
          label="10% pool available"
          value={`${toTonnes(availableKg).toFixed(2)} MT`}
          icon={Package}
          tone="taupe"
          hint={`${WASTE_PCT * 100}% of ${toTonnes(arrivedKg).toFixed(2)} MT arrived − sales`}
        />
        <StatCard
          label="Sold from pool"
          value={`${toTonnes(soldKg).toFixed(2)} MT`}
          icon={ArrowRight}
          tone="forest"
          hint={`${kg(soldKg)} · waste + pre-cleaner`}
        />
        <StatCard
          label="Committed"
          value={`${toTonnes(committedKg).toFixed(2)} MT`}
          icon={Package}
          tone="amber"
          hint="available + pending PO share"
        />
      </div>

      <Tabs value={tab} onValueChange={setTab} className="gap-4">
        <TabsList>
          <TabsTrigger value="precleaner-dust">Pre Cleaner Dust</TabsTrigger>
          <TabsTrigger value="waste">Tamarind Waste</TabsTrigger>
          <TabsTrigger value="nalla-pokkulu">Nalla Pokkulu</TabsTrigger>
          <TabsTrigger value="nalla-chintapandu">Nalla Chintapandu</TabsTrigger>
        </TabsList>

        <TabsContent value="precleaner-dust">
          <PreCleanerDust />
        </TabsContent>
        <TabsContent value="waste">
          <SalesProduct product="WASTE" hideHeader />
        </TabsContent>
        <TabsContent value="nalla-pokkulu">
          <SalesProduct product="NALLA_POKKULU" hideHeader />
        </TabsContent>
        <TabsContent value="nalla-chintapandu">
          <SalesProduct product="NALLA_CHINTAPANDU" hideHeader />
        </TabsContent>
      </Tabs>
    </div>
  );
}
