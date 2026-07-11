import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Landmark, Wallet, TrendingUp, TrendingDown, RefreshCcw, ChevronRight, ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { api } from '@/lib/api';
import type { GroupNode, LedgerNode } from '@/lib/types';
import { rupees } from '@/lib/format';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

// Signed amount → { value, Dr/Cr }. +Dr / −Cr.
function drcr(signed: number) {
  return { value: rupees(Math.abs(signed)), side: signed >= 0 ? 'Dr' : 'Cr' as const, isDr: signed >= 0 };
}

function sumByNature(roots: GroupNode[], nature: GroupNode['nature'], statement?: GroupNode['statement']) {
  return roots
    .filter((g) => g.nature === nature && (!statement || g.statement === statement))
    .reduce((s, g) => s + g.subtotal, 0);
}

function collectGroupIds(nodes: GroupNode[], acc: string[] = []): string[] {
  for (const n of nodes) {
    acc.push(n.id);
    collectGroupIds(n.children, acc);
  }
  return acc;
}

function LedgerRow({ ledger, depth }: { ledger: LedgerNode; depth: number }) {
  const d = drcr(ledger.closing);
  return (
    <TableRow className="hover:bg-muted/40">
      <TableCell style={{ paddingLeft: `${depth * 20 + 28}px` }} className="py-1.5">
        <span className="font-mono text-[10px] text-muted-foreground mr-2">{ledger.code}</span>
        <span className="text-sm text-foreground">{ledger.name}</span>
      </TableCell>
      <TableCell className="text-right font-mono text-xs text-muted-foreground tabular-nums">
        {ledger.openingBalance ? rupees(Math.abs(ledger.openingBalance)) : '-'}
      </TableCell>
      <TableCell className={cn('text-right font-mono text-sm tabular-nums', d.isDr ? 'text-foreground' : 'text-foreground')}>
        {Math.abs(ledger.closing) < 0.005 ? '-' : (
          <>
            {d.value} <span className="text-[10px] text-muted-foreground font-semibold">{d.side}</span>
          </>
        )}
      </TableCell>
    </TableRow>
  );
}

function GroupRows({ group, depth, open, toggle }: {
  group: GroupNode;
  depth: number;
  open: Set<string>;
  toggle: (id: string) => void;
}) {
  const isOpen = open.has(group.id);
  const d = drcr(group.subtotal);
  const isPrimary = depth === 0;

  return (
    <>
      <TableRow
        className={cn('cursor-pointer transition-colors', isPrimary ? 'bg-muted/60 hover:bg-muted' : 'bg-muted/20 hover:bg-muted/40')}
        onClick={() => toggle(group.id)}
      >
        <TableCell style={{ paddingLeft: `${depth * 20 + 8}px` }} className="py-2">
          <span className="inline-flex items-center gap-1.5">
            <ChevronRight className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', isOpen && 'rotate-90')} />
            <span className={cn(isPrimary ? 'font-bold text-foreground tracking-tight' : 'font-semibold text-foreground/90', 'text-sm')}>
              {group.name}
            </span>
          </span>
        </TableCell>
        <TableCell />
        <TableCell className="text-right font-mono text-sm font-semibold tabular-nums">
          {Math.abs(group.subtotal) < 0.005 ? '-' : (
            <>
              {d.value} <span className="text-[10px] text-muted-foreground font-semibold">{d.side}</span>
            </>
          )}
        </TableCell>
      </TableRow>
      {isOpen && (
        <>
          {group.children.map((c) => (
            <GroupRows key={c.id} group={c} depth={depth + 1} open={open} toggle={toggle} />
          ))}
          {group.ledgers.map((l) => (
            <LedgerRow key={l.id} ledger={l} depth={depth + 1} />
          ))}
        </>
      )}
    </>
  );
}

export default function Ledgers() {
  const { data: roots, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['ledger-accounts'],
    queryFn: () => api<GroupNode[]>('/ledger/accounts'),
  });

  const tree = roots ?? [];
  const [open, setOpen] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const expandAll = () => setOpen(new Set(collectGroupIds(tree)));
  const collapseAll = () => setOpen(new Set());

  // Summary (signed subtotals): assets +Dr, liabilities/capital −Cr.
  const totalAssets = sumByNature(tree, 'ASSETS', 'BALANCE_SHEET');
  const totalLiabilities = -sumByNature(tree, 'LIABILITIES', 'BALANCE_SHEET');
  const totalIncome = -sumByNature(tree, 'INCOME', 'PROFIT_LOSS');
  const totalExpense = sumByNature(tree, 'EXPENSES', 'PROFIT_LOSS');
  const netProfit = totalIncome - totalExpense;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Chart of Accounts</h1>
          <p className="text-muted-foreground">Tally-style grouped ledger with opening balances and live closing balances</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={expandAll} className="gap-1.5">
            <ChevronsUpDown className="h-4 w-4" /> Expand all
          </Button>
          <Button variant="outline" size="sm" onClick={collapseAll} className="gap-1.5">
            <ChevronsDownUp className="h-4 w-4" /> Collapse
          </Button>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isLoading || isRefetching} className="gap-1.5">
            <RefreshCcw className={`h-4 w-4 ${isRefetching ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Financial summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <SummaryCard title="Total Assets" value={totalAssets} icon={<Landmark className="h-4 w-4 text-emerald-500" />} accent="text-emerald-600 dark:text-emerald-500" hint="Fixed assets, investments & current assets" />
        <SummaryCard title="Liabilities & Capital" value={totalLiabilities} icon={<Wallet className="h-4 w-4 text-rose-500" />} accent="text-rose-600 dark:text-rose-500" hint="Capital, loans & current liabilities" />
        <SummaryCard title="Income (Current Period)" value={totalIncome} icon={<TrendingUp className="h-4 w-4 text-primary" />} accent="text-primary" hint="Sales & other income" />
        <SummaryCard title="Net Profit (Current Period)" value={netProfit} icon={<TrendingDown className="h-4 w-4 text-indigo-500" />} accent={netProfit >= 0 ? 'text-indigo-600 dark:text-indigo-400' : 'text-rose-500'} hint="Income minus expenses" />
      </div>

      {/* Grouped chart of accounts */}
      <div className="rounded-lg border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Group / Ledger</TableHead>
              <TableHead className="text-right w-40">Opening</TableHead>
              <TableHead className="text-right w-48">Closing Balance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow><TableCell colSpan={3} className="text-center text-muted-foreground py-8">Loading chart of accounts…</TableCell></TableRow>
            )}
            {!isLoading && tree.length === 0 && (
              <TableRow><TableCell colSpan={3} className="text-center text-muted-foreground py-8">No account groups found. Run the seed to load the chart of accounts.</TableCell></TableRow>
            )}
            {tree.map((g) => (
              <GroupRows key={g.id} group={g} depth={0} open={open} toggle={toggle} />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function SummaryCard({ title, value, icon, accent, hint }: {
  title: string; value: number; icon: React.ReactNode; accent: string; hint: string;
}) {
  return (
    <Card className="border bg-card shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        <div className={`text-2xl font-bold ${accent}`}>{rupees(Math.abs(value))}</div>
        <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p>
      </CardContent>
    </Card>
  );
}
