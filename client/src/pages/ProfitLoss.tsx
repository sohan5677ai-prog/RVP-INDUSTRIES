import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ProfitLoss as ProfitLossData } from '@/lib/types';
import { rupees, shortDate } from '@/lib/format';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, TrendingDown, Loader2, Leaf, Wheat, Scale, Lock } from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';
import { cn } from '@/lib/utils';

function Money({ amount, className }: { amount: number; className?: string }) {
  if (Math.abs(amount) < 0.005) return <span className={cn('text-muted-foreground', className)}>-</span>;
  const neg = amount < 0;
  return (
    <span className={cn('font-mono tabular-nums', neg && 'text-rose-600 dark:text-rose-400', className)}>
      {neg ? `(${rupees(Math.abs(amount))})` : rupees(amount)}
    </span>
  );
}

function prettyProduct(p: string): string {
  return p
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function Row({ label, amount, muted, strong, indent }: {
  label: React.ReactNode; amount: number; muted?: boolean; strong?: boolean; indent?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-baseline justify-between py-1.5',
        strong ? 'font-semibold text-foreground' : muted ? 'text-[13px] text-muted-foreground' : 'text-sm text-foreground/90'
      )}
      style={indent ? { paddingLeft: 16 } : undefined}
    >
      <span className={muted ? 'italic' : ''}>{label}</span>
      <Money amount={amount} className={strong ? 'font-semibold' : muted ? 'text-[13px]' : ''} />
    </div>
  );
}

export default function ProfitLoss() {
  const { data, isLoading } = useQuery({
    queryKey: ['profit-loss'],
    queryFn: () => api<ProfitLossData>('/reports/profit-loss'),
  });

  const isProfit = (data?.totals.estimatedNetProfit ?? data?.totals.netProfit ?? 0) >= 0;
  const isLockedProfit = (data?.totals.lockedNetProfit ?? data?.totals.netProfit ?? 0) >= 0;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={TrendingUp}
        title="Profit & Loss A/c"
        description="Pappu profit/loss with the husk pool absorbing all operating overheads."
      />

      {isLoading ? (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : !data ? (
        <Card className="p-8 text-center text-muted-foreground">Unable to load the profit &amp; loss statement.</Card>
      ) : (
        <>
          <div className="flex items-center justify-between flex-wrap gap-3">
            <p className="text-sm text-muted-foreground">For the period ending {shortDate(data.period)}</p>
            <div className="flex items-center gap-4 text-sm font-bold">
              <span className={cn('inline-flex items-center gap-1.5', isLockedProfit ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>
                <Lock className="h-3.5 w-3.5" /> Locked Net Profit: {rupees(data.totals.lockedNetProfit ?? data.totals.netProfit)}
              </span>
              <span className="text-muted-foreground">•</span>
              <span className={cn('inline-flex items-center gap-1.5', isProfit ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>
                Estimated Net Profit: {rupees(data.totals.estimatedNetProfit ?? data.totals.netProfit)}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Pappu P/L */}
            <Card className="p-0 overflow-hidden">
              <div className="px-5 py-3 border-b bg-muted/50 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Wheat className="h-4 w-4 text-amber-500" />
                  <h2 className="text-sm font-bold uppercase tracking-wider text-foreground">Pappu Profit &amp; Loss</h2>
                </div>
                {data.pappu.lockedOrders != null && (
                  <Badge variant="outline" className="text-[11px] font-mono gap-1 border-indigo-200 text-indigo-700 dark:border-indigo-900 dark:text-indigo-400">
                    <Lock className="h-3 w-3" /> {data.pappu.lockedOrders} of {data.pappu.orders} Locked
                  </Badge>
                )}
              </div>
              <div className="px-5 py-4 space-y-3">
                <p className="text-xs text-muted-foreground">
                  Core-product result across {data.pappu.orders} order{data.pappu.orders === 1 ? '' : 's'} — revenue net of
                  seed cost, milling, freight &amp; brokerage.
                </p>
                <div className="space-y-2 border-t pt-3">
                  <div className="flex items-baseline justify-between">
                    <span className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                      <Lock className="h-3.5 w-3.5 text-indigo-500" /> Pappu Locked Profit
                    </span>
                    <span className={cn('font-mono font-bold tabular-nums text-lg', (data.pappu.lockedProfit ?? data.pappu.profitLoss) >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>
                      {rupees(data.pappu.lockedProfit ?? data.pappu.profitLoss)}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between text-xs text-muted-foreground pt-1">
                    <span>Pappu Estimated Profit (total pipeline)</span>
                    <span className="font-mono font-semibold tabular-nums text-foreground">
                      {rupees(data.pappu.estimatedProfit ?? data.pappu.profitLoss)}
                    </span>
                  </div>
                </div>
              </div>
            </Card>

            {/* Husk pool */}
            <Card className="p-0 overflow-hidden">
              <div className="px-5 py-3 border-b bg-muted/50 flex items-center gap-2">
                <Leaf className="h-4 w-4 text-emerald-500" />
                <h2 className="text-sm font-bold uppercase tracking-wider text-foreground">Husk Pool</h2>
              </div>
              <div className="px-5 py-3">
                {/* Byproduct income */}
                <Row label="Byproduct income" amount={data.huskPool.byproductIncome} strong />
                {data.huskPool.byproducts.length === 0 && (
                  <div className="py-1 pl-4 text-[13px] italic text-muted-foreground">No byproduct sales yet.</div>
                )}
                {data.huskPool.byproducts.map((b) => (
                  <Row key={b.product} label={prettyProduct(b.product)} amount={b.amount} muted indent />
                ))}

                {/* Other income streams: Kata Income, Hamali Company Profit, Gunny Sales, Other Income */}
                <div className="mt-2 border-t pt-2">
                  <Row label="Other income" amount={data.huskPool.otherIncomeTotal} strong />
                  {data.huskPool.incomeLines.length === 0 && (
                    <div className="py-1 pl-4 text-[13px] italic text-muted-foreground">No other income recorded yet.</div>
                  )}
                  {data.huskPool.incomeLines.map((l) => (
                    <Row key={l.code} label={l.name} amount={l.amount} muted indent />
                  ))}
                </div>

                {/* Overheads */}
                <div className="mt-2 border-t pt-2">
                  <Row label="Less: operating overheads" amount={-data.huskPool.overheadExpenses} strong />
                  {data.huskPool.overheadLedgers.length === 0 && (
                    <div className="py-1 pl-4 text-[13px] italic text-muted-foreground">No overheads posted.</div>
                  )}
                  {data.huskPool.overheadLedgers.map((l) => (
                    <Row key={l.code} label={l.name} amount={-l.amount} muted indent />
                  ))}
                </div>

                {/* Pool result */}
                <div className="mt-2 flex items-baseline justify-between border-t-2 border-foreground/20 pt-2.5">
                  <span className="font-bold text-foreground">
                    Pool {data.huskPool.isDeficit ? 'Deficit' : 'Surplus'}
                  </span>
                  <span className={cn('font-mono font-bold tabular-nums', data.huskPool.isDeficit ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400')}>
                    {data.huskPool.isDeficit ? `(${rupees(Math.abs(data.huskPool.net))})` : rupees(data.huskPool.net)}
                  </span>
                </div>
              </div>
            </Card>
          </div>

          {/* Net reconciliation */}
          <Card className="p-0 overflow-hidden">
            <div className="px-5 py-3 border-b bg-muted/50 flex items-center gap-2">
              <Scale className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-bold uppercase tracking-wider text-foreground">Net Profit &amp; Loss</h2>
            </div>
            <div className="px-5 py-3 divide-y divide-border/60">
              <Row label="Pappu Locked Profit" amount={data.pappu.lockedProfit ?? data.pappu.profitLoss} strong />
              <Row label="Pappu Estimated Profit (total pipeline)" amount={data.pappu.estimatedProfit ?? data.pappu.profitLoss} muted indent />
              <Row
                label={data.huskPool.isDeficit ? 'Less: Husk pool deficit' : 'Add: Husk pool surplus'}
                amount={data.huskPool.net}
              />
              <div className="pt-3 space-y-2">
                <div className="flex items-baseline justify-between">
                  <span className="inline-flex items-center gap-1.5 font-bold text-foreground">
                    <Lock className="h-4 w-4 text-indigo-500" />
                    Locked Net Profit
                  </span>
                  <span className={cn('font-mono font-bold tabular-nums text-xl', isLockedProfit ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>
                    {rupees(data.totals.lockedNetProfit ?? data.totals.netProfit)}
                  </span>
                </div>
                <div className="flex items-baseline justify-between text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    {isProfit ? <TrendingUp className="h-3.5 w-3.5 text-emerald-500" /> : <TrendingDown className="h-3.5 w-3.5 text-rose-500" />}
                    Estimated Net Profit (pipeline)
                  </span>
                  <span className={cn('font-mono font-semibold tabular-nums', isProfit ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>
                    {rupees(data.totals.estimatedNetProfit ?? data.totals.netProfit)}
                  </span>
                </div>
              </div>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
