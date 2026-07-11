import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ProfitLoss as ProfitLossData } from '@/lib/types';
import { rupees, shortDate } from '@/lib/format';
import { Card } from '@/components/ui/card';
import { TrendingUp, TrendingDown, Loader2, Leaf, Wheat, Scale } from 'lucide-react';
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

  const isProfit = (data?.totals.netProfit ?? 0) >= 0;

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
            <span className={cn('inline-flex items-center gap-1.5 text-sm font-bold', isProfit ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>
              {isProfit ? 'Net Profit' : 'Net Loss'}: {rupees(Math.abs(data.totals.netProfit))}
            </span>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Pappu P/L */}
            <Card className="p-0 overflow-hidden">
              <div className="px-5 py-3 border-b bg-muted/50 flex items-center gap-2">
                <Wheat className="h-4 w-4 text-amber-500" />
                <h2 className="text-sm font-bold uppercase tracking-wider text-foreground">Pappu Profit &amp; Loss</h2>
              </div>
              <div className="px-5 py-4">
                <p className="text-xs text-muted-foreground mb-3">
                  Core-product result across {data.pappu.orders} order{data.pappu.orders === 1 ? '' : 's'} — revenue net of
                  seed cost, milling, freight &amp; brokerage.
                </p>
                <div className="flex items-baseline justify-between border-t pt-3">
                  <span className="font-bold text-foreground">Pappu {data.pappu.profitLoss >= 0 ? 'Profit' : 'Loss'}</span>
                  <span className={cn('font-mono font-bold tabular-nums text-lg', data.pappu.profitLoss >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>
                    {rupees(Math.abs(data.pappu.profitLoss))}
                  </span>
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
              <Row label="Pappu Profit / Loss" amount={data.pappu.profitLoss} />
              <Row
                label={data.huskPool.isDeficit ? 'Less: Husk pool deficit' : 'Add: Husk pool surplus'}
                amount={data.huskPool.net}
              />
              <div className="flex items-baseline justify-between pt-3">
                <span className="inline-flex items-center gap-1.5 font-bold text-foreground">
                  {isProfit ? <TrendingUp className="h-4 w-4 text-emerald-500" /> : <TrendingDown className="h-4 w-4 text-rose-500" />}
                  Net {isProfit ? 'Profit' : 'Loss'}
                </span>
                <span className={cn('font-mono font-bold tabular-nums text-xl', isProfit ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>
                  {rupees(Math.abs(data.totals.netProfit))}
                </span>
              </div>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
