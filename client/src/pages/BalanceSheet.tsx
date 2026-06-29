import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { BalanceSheet as BalanceSheetData, ReportGroup } from '@/lib/types';
import { rupees, shortDate } from '@/lib/format';
import { Card } from '@/components/ui/card';
import { Scale, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
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

// Recursive Tally group: group → sub-groups → ledgers, indented.
function GroupRows({ group, depth }: { group: ReportGroup; depth: number }) {
  return (
    <>
      <div
        className={cn(
          'flex items-baseline justify-between py-1.5',
          depth === 0 ? 'font-semibold text-foreground' : 'text-sm text-foreground/90'
        )}
        style={{ paddingLeft: `${depth * 16}px` }}
      >
        <span>{group.name}</span>
        <Money amount={group.amount} className={depth === 0 ? 'font-semibold' : ''} />
      </div>
      {group.children?.map((c) => (
        <GroupRows key={c.name} group={c} depth={depth + 1} />
      ))}
      {group.ledgers?.map((l) => (
        <div
          key={l.code + l.name}
          className="flex items-baseline justify-between py-1 text-[13px] text-muted-foreground"
          style={{ paddingLeft: `${(depth + 1) * 16}px` }}
        >
          <span className="italic">{l.name}</span>
          <Money amount={l.amount} className="text-[13px]" />
        </div>
      ))}
    </>
  );
}

function Column({ title, groups, total }: { title: string; groups: ReportGroup[]; total: number }) {
  return (
    <Card className="p-0 overflow-hidden">
      <div className="px-5 py-3 border-b bg-muted/50 flex items-center justify-between">
        <h2 className="text-sm font-bold uppercase tracking-wider text-foreground">{title}</h2>
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">as at</span>
      </div>
      <div className="px-5 py-3 divide-y divide-border/60">
        {groups.length === 0 && <div className="py-6 text-center text-sm text-muted-foreground">No balances.</div>}
        {groups.map((g) => (
          <div key={g.name} className="py-1">
            <GroupRows group={g} depth={0} />
          </div>
        ))}
      </div>
      <div className="px-5 py-3 border-t-2 border-foreground/20 bg-muted/40 flex items-center justify-between">
        <span className="font-bold text-foreground">Total</span>
        <span className="font-mono font-bold tabular-nums text-foreground">{rupees(total)}</span>
      </div>
    </Card>
  );
}

export default function BalanceSheet() {
  const { data, isLoading } = useQuery({
    queryKey: ['balance-sheet'],
    queryFn: () => api<BalanceSheetData>('/reports/balance-sheet'),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Scale}
        title="Balance Sheet"
        description="Tally-style statement of financial position — opening balances plus live movements."
      />

      {isLoading ? (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : !data ? (
        <Card className="p-8 text-center text-muted-foreground">Unable to load the balance sheet.</Card>
      ) : (
        <>
          <div className="flex items-center justify-between flex-wrap gap-3">
            <p className="text-sm text-muted-foreground">As at {shortDate(data.asOf)}</p>
            {data.totals.balanced ? (
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-4 w-4" /> Balanced — both sides tie to {rupees(data.totals.assets)}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-4 w-4" /> Out of balance by {rupees(Math.abs(data.totals.difference))}
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Column title="Liabilities" groups={data.liabilities} total={data.totals.liabilities} />
            <Column title="Assets" groups={data.assets} total={data.totals.assets} />
          </div>
        </>
      )}
    </div>
  );
}
