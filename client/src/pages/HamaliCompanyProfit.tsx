import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { HandCoins, Loader2, ArrowUpRight } from 'lucide-react';
import { api } from '@/lib/api';
import { rupees } from '@/lib/format';
import { StatCard } from '@/components/StatCard';
import { Button } from '@/components/ui/button';
import type { HuskPnl } from './DashboardCharts';

// Read-only income summary: every hamali margin (purchase unloading + sale
// loading + stock-transfer legs) posts to GL 40030 "Hamali Income" at booking
// time (see ledger.service.ts / computeHuskPool.hamaliCompanyProfit). The full
// itemized breakdown lives on the Hamali Ledger's Company view.
export default function HamaliCompanyProfit() {
  const { data, isLoading } = useQuery({
    queryKey: ['husk-pnl'],
    queryFn: () => api<HuskPnl>('/reports/husk-pnl'),
  });

  const profit = data?.income?.hamaliCompanyProfit ?? 0;

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Company margin retained on every hamali charge - unloading at purchase, loading at sale dispatch, and stock-transfer legs.
          Added to the husk recovery pool and the Profit &amp; Loss as income.
        </p>
        <Button variant="outline" asChild>
          <Link to="/accounts/hamali-ledger">
            Full Hamali Ledger <ArrowUpRight className="h-4 w-4 ml-1.5" />
          </Link>
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-32">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <StatCard label="Hamali company profit" value={rupees(profit)} icon={HandCoins} tone="forest" hint="all-time margin, GL 40030" />
          <StatCard label="See the breakdown" value="Hamali Ledger" icon={HandCoins} tone="amber" hint="Company view - Accounts section" />
        </div>
      )}
    </div>
  );
}
