import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ProfitLoss as ProfitLossData, ReportGroup } from '@/lib/types';
import { rupees, shortDate } from '@/lib/format';
import { Card } from '@/components/ui/card';
import { TrendingUp, Loader2 } from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';
import { cn } from '@/lib/utils';

function Money({ amount, className }: { amount: number; className?: string }) {
  if (Math.abs(amount) < 0.005) return <span className={cn('text-muted-foreground', className)}>—</span>;
  const neg = amount < 0;
  return (
    <span className={cn('font-mono tabular-nums', neg && 'text-rose-600 dark:text-rose-400', className)}>
      {neg ? `(${rupees(Math.abs(amount))})` : rupees(amount)}
    </span>
  );
}

function GroupRows({ group, depth }: { group: ReportGroup; depth: number }) {
  return (
    <>
      <div
        className={cn('flex items-baseline justify-between py-1.5', depth === 0 ? 'font-semibold text-foreground' : 'text-sm text-foreground/90')}
        style={{ paddingLeft: `${depth * 16}px` }}
      >
        <span>{group.name}</span>
        <Money amount={group.amount} className={depth === 0 ? 'font-semibold' : ''} />
      </div>
      {group.children?.map((c) => <GroupRows key={c.name} group={c} depth={depth + 1} />)}
      {group.ledgers?.map((l) => (
        <div key={l.code + l.name} className="flex items-baseline justify-between py-1 text-[13px] text-muted-foreground" style={{ paddingLeft: `${(depth + 1) * 16}px` }}>
          <span className="italic">{l.name}</span>
          <Money amount={l.amount} className="text-[13px]" />
        </div>
      ))}
    </>
  );
}

function Column({ title, groups, balancingLabel, balancingAmount, total }: {
  title: string;
  groups: ReportGroup[];
  balancingLabel?: string;
  balancingAmount?: number;
  total: number;
}) {
  return (
    <Card className="p-0 overflow-hidden">
      <div className="px-5 py-3 border-b bg-muted/50">
        <h2 className="text-sm font-bold uppercase tracking-wider text-foreground">{title}</h2>
      </div>
      <div className="px-5 py-3 divide-y divide-border/60">
        {groups.length === 0 && <div className="py-6 text-center text-sm text-muted-foreground">No balances.</div>}
        {groups.map((g) => (
          <div key={g.name} className="py-1"><GroupRows group={g} depth={0} /></div>
        ))}
        {balancingLabel && (
          <div className="flex items-baseline justify-between py-2 font-bold text-emerald-700 dark:text-emerald-400">
            <span>{balancingLabel}</span>
            <span className="font-mono tabular-nums">{rupees(balancingAmount ?? 0)}</span>
          </div>
        )}
      </div>
      <div className="px-5 py-3 border-t-2 border-foreground/20 bg-muted/40 flex items-center justify-between">
        <span className="font-bold text-foreground">Total</span>
        <span className="font-mono font-bold tabular-nums text-foreground">{rupees(total)}</span>
      </div>
    </Card>
  );
}

export default function ProfitLoss() {
  const { data, isLoading } = useQuery({
    queryKey: ['profit-loss'],
    queryFn: () => api<ProfitLossData>('/reports/profit-loss'),
  });

  const isProfit = (data?.totals.netProfit ?? 0) >= 0;
  const grand = Math.max(data?.totals.income ?? 0, data?.totals.expenses ?? 0);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={TrendingUp}
        title="Profit & Loss A/c"
        description="Current-period trading result — income against expenses (perpetual basis, COGS-driven)."
      />

      {isLoading ? (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : !data ? (
        <Card className="p-8 text-center text-muted-foreground">Unable to load the profit & loss statement.</Card>
      ) : (
        <>
          <div className="flex items-center justify-between flex-wrap gap-3">
            <p className="text-sm text-muted-foreground">For the period ending {shortDate(data.period)}</p>
            <span className={cn('inline-flex items-center gap-1.5 text-sm font-bold', isProfit ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>
              {isProfit ? 'Net Profit' : 'Net Loss'}: {rupees(Math.abs(data.totals.netProfit))}
            </span>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Column
              title="Expenses"
              groups={data.expenses}
              balancingLabel={isProfit ? 'Net Profit c/o' : undefined}
              balancingAmount={isProfit ? data.totals.netProfit : undefined}
              total={grand}
            />
            <Column
              title="Income"
              groups={data.income}
              balancingLabel={!isProfit ? 'Net Loss c/o' : undefined}
              balancingAmount={!isProfit ? Math.abs(data.totals.netProfit) : undefined}
              total={grand}
            />
          </div>
        </>
      )}
    </div>
  );
}
