import { Fragment, useMemo, useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { TrendingUp, TrendingDown, IndianRupee, PackageCheck, Scale, Percent, ChevronRight, Trophy, AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
import { rupees, rupeesShort, shortDate, toTonnes } from '@/lib/format';
import {
  Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/PageHeader';
import { Segmented } from '@/components/ui/segmented';
import { Combobox } from '@/components/ui/combobox';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * Per-order Pappu profit/loss, from the date-aware seed allocation (server).
 * Mirrors the panel shown per-row on the Pappu sales page - see
 * getPappuOrderMargins in server/src/controllers/inventory.controller.ts.
 */
interface PappuMargin {
  orderId: string;
  buyer: string;
  destination: string | null;
  saleDate: string;
  committedPappuKg: number;
  orderedKg: number;
  ratePerKg: number;
  revenue: number;
  freight: number;
  freightPerKg: number;
  brokerage: number;
  seedKg: number;
  seedCost: number;
  seedWacPerKg: number;
  seedCostPerPappuKg: number;
  prodCostPerKg: number;
  prodCost: number;
  netRealization: number;
  margin: number;
  marginPerKg: number;
  marginPct: number;
  seedBands: { price: number; seedKg: number; cost: number }[];
}

type ProfitFilter = 'ALL' | 'PROFIT' | 'LOSS';
type SortKey = 'DATE' | 'MARGIN' | 'REVENUE' | 'MARGIN_PCT';

const SORT_OPTIONS: { label: string; value: SortKey }[] = [
  { label: 'Date', value: 'DATE' },
  { label: 'Net P/L', value: 'MARGIN' },
  { label: 'Revenue', value: 'REVENUE' },
  { label: 'Margin %', value: 'MARGIN_PCT' },
];

export default function PappuProfitLoss() {
  const { data: margins, isLoading } = useQuery({
    queryKey: ['pappu-margins'],
    queryFn: () => api<PappuMargin[]>('/inventory/pappu-margins'),
  });

  const [profitFilter, setProfitFilter] = useState<ProfitFilter>('ALL');
  const [buyerFilter, setBuyerFilter] = useState<string>('ALL');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('DATE');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  
  // Top scrollbar synchronization refs
  const topScrollRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [tableScrollWidth, setTableScrollWidth] = useState(0);

  // Set up synchronized scrolling and width observation
  useEffect(() => {
    const topScroller = topScrollRef.current;
    const tableScroller = wrapperRef.current?.querySelector('[data-slot="table-container"]') as HTMLDivElement;
    if (!topScroller || !tableScroller) return;

    const updateWidth = () => setTableScrollWidth(tableScroller.scrollWidth);
    updateWidth();
    
    const observer = new ResizeObserver(updateWidth);
    if (tableScroller.firstElementChild) observer.observe(tableScroller.firstElementChild);

    const onTopScroll = () => { tableScroller.scrollLeft = topScroller.scrollLeft; };
    const onTableScroll = () => { topScroller.scrollLeft = tableScroller.scrollLeft; };

    topScroller.addEventListener('scroll', onTopScroll, { passive: true });
    tableScroller.addEventListener('scroll', onTableScroll, { passive: true });

    return () => {
      topScroller.removeEventListener('scroll', onTopScroll);
      tableScroller.removeEventListener('scroll', onTableScroll);
      observer.disconnect();
    };
  }, [margins, profitFilter, buyerFilter, fromDate, toDate, sortKey]);

  const toggleRow = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const buyerOptions = useMemo(() => {
    const names = Array.from(new Set((margins ?? []).map((m) => m.buyer))).sort();
    return [{ value: 'ALL', label: 'All buyers' }, ...names.map((n) => ({ value: n, label: n }))];
  }, [margins]);

  const visible = useMemo(() => {
    const rows = (margins ?? []).filter((m) => {
      if (profitFilter === 'PROFIT' && m.margin < 0) return false;
      if (profitFilter === 'LOSS' && m.margin >= 0) return false;
      if (buyerFilter !== 'ALL' && m.buyer !== buyerFilter) return false;
      const d = m.saleDate.slice(0, 10);
      if (fromDate && d < fromDate) return false;
      if (toDate && d > toDate) return false;
      return true;
    });
    const sorted = [...rows];
    switch (sortKey) {
      case 'MARGIN': sorted.sort((a, b) => b.margin - a.margin); break;
      case 'REVENUE': sorted.sort((a, b) => b.revenue - a.revenue); break;
      case 'MARGIN_PCT': sorted.sort((a, b) => b.marginPct - a.marginPct); break;
      default: sorted.sort((a, b) => new Date(b.saleDate).getTime() - new Date(a.saleDate).getTime());
    }
    return sorted;
  }, [margins, profitFilter, buyerFilter, fromDate, toDate, sortKey]);

  // ── Aggregate metrics (over the filtered set) ──────────────────────────────
  const t = useMemo(() => {
    const sum = (f: (m: PappuMargin) => number) => visible.reduce((s, m) => s + f(m), 0);
    const soldKg = sum((m) => m.orderedKg);
    const revenue = sum((m) => m.revenue);
    const freight = sum((m) => m.freight);
    const brokerage = sum((m) => m.brokerage);
    const seedCost = sum((m) => m.seedCost);
    const prodCost = sum((m) => m.prodCost);
    const margin = sum((m) => m.margin);
    const profitOrders = visible.filter((m) => m.margin >= 0);
    const lossOrders = visible.filter((m) => m.margin < 0);
    const best = visible.reduce<PappuMargin | null>((b, m) => (!b || m.margin > b.margin ? m : b), null);
    const worst = visible.reduce<PappuMargin | null>((w, m) => (!w || m.margin < w.margin ? m : w), null);
    return {
      soldKg, revenue, freight, brokerage, seedCost, prodCost, margin,
      netRealization: sum((m) => m.netRealization),
      totalCost: freight + brokerage + seedCost + prodCost,
      marginPct: revenue > 0 ? (margin / revenue) * 100 : 0,
      marginPerKg: soldKg > 0 ? margin / soldKg : 0,
      avgSalePerKg: soldKg > 0 ? revenue / soldKg : 0,
      seedCostPerKg: soldKg > 0 ? seedCost / soldKg : 0,
      orders: visible.length,
      profitCount: profitOrders.length,
      lossCount: lossOrders.length,
      lossValue: lossOrders.reduce((s, m) => s + m.margin, 0),
      best, worst,
    };
  }, [visible]);

  const filtersActive = profitFilter !== 'ALL' || buyerFilter !== 'ALL' || !!fromDate || !!toDate;
  const pnlClass = (v: number) => (v >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400');

  return (
    <div className="space-y-6">
      <PageHeader
        icon={TrendingUp}
        title="Pappu Profit & Loss"
        description="Order-by-order profitability of every Pappu sale - revenue net of freight & brokerage, less the date-aware black-seed cost and production cost that actually backed each order."
      />

      {/* Headline metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Net Profit / Loss</CardTitle>
            {t.margin >= 0 ? <TrendingUp className="h-4 w-4 text-emerald-500" /> : <TrendingDown className="h-4 w-4 text-rose-500" />}
          </CardHeader>
          <CardContent>
            <div className={cn('text-2xl font-bold', pnlClass(t.margin))}>{rupees(t.margin)}</div>
            <p className="text-[10px] text-muted-foreground mt-1">{t.marginPct.toFixed(2)}% margin · {rupees(t.marginPerKg)}/kg</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Revenue</CardTitle>
            <IndianRupee className="h-4 w-4 text-sky-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-sky-600">{rupees(t.revenue)}</div>
            <p className="text-[10px] text-muted-foreground mt-1">Avg {rupees(t.avgSalePerKg)}/kg sale price</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Cost</CardTitle>
            <Scale className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-amber-600">{rupees(t.totalCost)}</div>
            <p className="text-[10px] text-muted-foreground mt-1">Seed + production + freight + brokerage</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Pappu Sold</CardTitle>
            <PackageCheck className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-emerald-600">{toTonnes(t.soldKg).toFixed(2)} MT</div>
            <p className="text-[10px] text-muted-foreground mt-1">Across {t.orders} order{t.orders === 1 ? '' : 's'}</p>
          </CardContent>
        </Card>
      </div>

      {/* Secondary metrics strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <MiniStat icon={Percent} label="Overall margin" value={`${t.marginPct.toFixed(2)}%`} valueClass={pnlClass(t.margin)} />
        <MiniStat icon={TrendingUp} label="Profitable orders" value={`${t.profitCount}`} sub={`of ${t.orders}`} valueClass="text-emerald-600 dark:text-emerald-400" />
        <MiniStat icon={TrendingDown} label="Loss orders" value={`${t.lossCount}`} sub={t.lossValue < 0 ? rupeesShort(t.lossValue) : '-'} valueClass="text-rose-600 dark:text-rose-400" />
        <MiniStat icon={Scale} label="Black seed cost" value={rupeesShort(t.seedCost)} sub={`${rupees(t.seedCostPerKg)}/kg pappu`} />
        <MiniStat icon={Trophy} label="Best order" value={t.best ? rupeesShort(t.best.margin) : '-'} sub={t.best?.buyer} valueClass="text-emerald-600 dark:text-emerald-400" />
        <MiniStat icon={AlertTriangle} label="Worst order" value={t.worst ? rupeesShort(t.worst.margin) : '-'} sub={t.worst?.buyer} valueClass={t.worst && t.worst.margin < 0 ? 'text-rose-600 dark:text-rose-400' : undefined} />
      </div>

      {/* Filters */}
      <div className="glass rounded-2xl p-3 flex flex-wrap items-center gap-2.5">
        <Segmented
          options={[
            { label: 'All', value: 'ALL' },
            { label: 'Profit', value: 'PROFIT' },
            { label: 'Loss', value: 'LOSS' },
          ]}
          value={profitFilter}
          onValueChange={setProfitFilter}
          size="sm"
        />
        <Combobox
          options={buyerOptions}
          value={buyerFilter}
          onChange={setBuyerFilter}
          placeholder="All buyers"
          searchPlaceholder="Search buyer…"
          ariaLabel="Filter by buyer"
          className="w-52"
        />
        <div className="flex items-center gap-1.5">
          <Input aria-label="From date" type="date" value={fromDate} max={toDate || undefined} onChange={(e) => setFromDate(e.target.value)} className="w-40" />
          <span className="text-muted-foreground text-xs">→</span>
          <Input aria-label="To date" type="date" value={toDate} min={fromDate || undefined} onChange={(e) => setToDate(e.target.value)} className="w-40" />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Sort</span>
          <Segmented options={SORT_OPTIONS} value={sortKey} onValueChange={setSortKey} size="sm" />
        </div>
        {filtersActive && (
          <button type="button" onClick={() => { setProfitFilter('ALL'); setBuyerFilter('ALL'); setFromDate(''); setToDate(''); }}
            className="ml-auto text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">Clear filters</button>
        )}
      </div>

      {/* Top Scrollbar for Table */}
      <div 
        ref={topScrollRef} 
        className="w-full overflow-x-auto hide-scrollbar-y bg-background/50 rounded-t-lg border-b border-border/40"
        style={{ marginBottom: '-1rem' }}
      >
        <div style={{ width: tableScrollWidth, height: '12px' }} />
      </div>

      {/* Detailed P/L table */}
      <div className="glass rounded-b-2xl rounded-t-md overflow-hidden relative z-10" ref={wrapperRef}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Buyer</TableHead>
              <TableHead>Destination</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Sale/kg</TableHead>
              <TableHead className="text-right">Revenue</TableHead>
              <TableHead className="text-right">Freight</TableHead>
              <TableHead className="text-right">Brokerage</TableHead>
              <TableHead className="text-right">Seed cost</TableHead>
              <TableHead className="text-right">Production</TableHead>
              <TableHead className="text-right">Net P/L</TableHead>
              <TableHead className="text-right">₹/kg</TableHead>
              <TableHead className="text-right">Margin %</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && <TableRow><TableCell colSpan={13} className="h-24 text-center text-muted-foreground">Loading…</TableCell></TableRow>}
            {!isLoading && visible.length === 0 && (
              <TableRow><TableCell colSpan={13} className="h-28 text-center text-muted-foreground">No Pappu orders matching filters.</TableCell></TableRow>
            )}
            {visible.map((m) => {
              const isOpen = expanded.has(m.orderId);
              return (
                <Fragment key={m.orderId}>
                  <TableRow className={cn('cursor-pointer transition-colors', isOpen ? 'bg-accent/40' : 'hover:bg-accent/30')} onClick={() => toggleRow(m.orderId)}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <ChevronRight className={cn('h-4 w-4 text-muted-foreground transition-transform duration-200', isOpen && 'rotate-90 text-primary')} />
                        <span className="text-muted-foreground whitespace-nowrap">{shortDate(m.saleDate)}</span>
                      </div>
                    </TableCell>
                    <TableCell className="font-medium text-foreground">{m.buyer}</TableCell>
                    <TableCell className="text-muted-foreground">{m.destination ?? '-'}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{toTonnes(m.orderedKg).toFixed(2)} t</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{rupees(m.ratePerKg)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{rupees(m.revenue)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-muted-foreground">{rupees(m.freight)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-muted-foreground">{m.brokerage > 0 ? rupees(m.brokerage) : '-'}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-muted-foreground">{rupees(m.seedCost)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-muted-foreground">{m.prodCost > 0 ? rupees(m.prodCost) : '-'}</TableCell>
                    <TableCell className={cn('text-right font-mono tabular-nums font-semibold', pnlClass(m.margin))}>{rupees(m.margin)}</TableCell>
                    <TableCell className={cn('text-right font-mono tabular-nums', pnlClass(m.margin))}>{rupees(m.marginPerKg)}</TableCell>
                    <TableCell className="text-right">
                      <Badge variant={m.margin >= 0 ? 'success' : 'warning'} className={m.margin < 0 ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-400' : undefined}>
                        {m.marginPct.toFixed(1)}%
                      </Badge>
                    </TableCell>
                  </TableRow>

                  {/* Expanded breakdown */}
                  {isOpen && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={13} className="p-0">
                        <div className="border-t border-border/60 bg-muted/25 px-5 py-4">
                          <PappuMarginPanel m={m} />
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
          {!isLoading && visible.length > 0 && (
            <TableFooter>
              <TableRow className="border-t-2 border-border font-semibold">
                <TableCell colSpan={3} className="font-bold">Total · {visible.length} order{visible.length === 1 ? '' : 's'}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{toTonnes(t.soldKg).toFixed(2)} t</TableCell>
                <TableCell className="text-right font-mono tabular-nums text-muted-foreground">{rupees(t.avgSalePerKg)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{rupees(t.revenue)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums text-muted-foreground">{rupees(t.freight)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums text-muted-foreground">{rupees(t.brokerage)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums text-muted-foreground">{rupees(t.seedCost)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums text-muted-foreground">{rupees(t.prodCost)}</TableCell>
                <TableCell className={cn('text-right font-mono tabular-nums font-bold', pnlClass(t.margin))}>{rupees(t.margin)}</TableCell>
                <TableCell className={cn('text-right font-mono tabular-nums', pnlClass(t.margin))}>{rupees(t.marginPerKg)}</TableCell>
                <TableCell className={cn('text-right font-mono tabular-nums font-bold', pnlClass(t.margin))}>{t.marginPct.toFixed(1)}%</TableCell>
              </TableRow>
            </TableFooter>
          )}
        </Table>
      </div>
    </div>
  );
}

function MiniStat({ icon: Icon, label, value, sub, valueClass }: {
  icon: React.ComponentType<{ className?: string }>; label: string; value: string; sub?: string; valueClass?: string;
}) {
  return (
    <div className="glass rounded-xl px-3.5 py-3">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3.5 w-3.5" /> {label}
      </div>
      <div className={cn('mt-1 text-lg font-bold', valueClass ?? 'text-foreground')}>{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground truncate">{sub}</div>}
    </div>
  );
}

/**
 * Rich per-order Pappu P/L panel shown inside the expanded row: a P/L headline,
 * a "where the revenue goes" composition bar, accent-bordered cost tiles, and the
 * date-aware black-seed allocation chips. Mirrors the panel on the Pappu sales page.
 */
function PappuMarginPanel({ m }: { m: PappuMargin }) {
  const isProfit = m.margin >= 0;
  const pnlText = isProfit ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400';

  // Bar denominator = whichever is larger, so both profit and loss orders fill it.
  const costs = m.freight + m.brokerage + m.seedCost + m.prodCost;
  const denom = Math.max(m.revenue, costs, 1);
  const width = (v: number) => `${(v / denom) * 100}%`;

  const segments = [
    { key: 'seed', label: 'Black seed', value: m.seedCost, color: 'bg-amber-500' },
    { key: 'prod', label: 'Production', value: m.prodCost, color: 'bg-orange-400' },
    { key: 'freight', label: 'Freight', value: m.freight, color: 'bg-slate-400' },
    { key: 'brokerage', label: 'Brokerage', value: m.brokerage, color: 'bg-violet-400' },
    ...(isProfit ? [{ key: 'margin', label: 'Margin', value: m.margin, color: 'bg-emerald-500' }] : []),
  ].filter((s) => s.value > 0);

  return (
    <div className="overflow-hidden rounded-2xl border border-border/70 bg-card/70 shadow-sm">
      {/* Headline */}
      <div className={cn('flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-3', isProfit ? 'bg-emerald-500/[0.06]' : 'bg-rose-500/[0.06]')}>
        <div className="flex items-center gap-3">
          <div className={cn('flex h-10 w-10 items-center justify-center rounded-xl', isProfit ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-rose-500/15 text-rose-600 dark:text-rose-400')}>
            {isProfit ? <TrendingUp className="h-5 w-5" /> : <TrendingDown className="h-5 w-5" />}
          </div>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{isProfit ? 'Profit' : 'Loss'} · {m.buyer}</div>
            <div className={cn('font-mono text-xl font-extrabold leading-tight tabular-nums', pnlText)}>{isProfit ? '+' : ''}{rupees(m.margin)}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="rounded-lg border border-border/60 bg-background/70 px-3 py-1.5 text-center">
            <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">Margin</div>
            <div className={cn('font-mono text-sm font-bold tabular-nums', pnlText)}>{m.marginPct.toFixed(1)}%</div>
          </div>
          <div className="rounded-lg border border-border/60 bg-background/70 px-3 py-1.5 text-center">
            <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">Per kg</div>
            <div className={cn('font-mono text-sm font-bold tabular-nums', pnlText)}>{rupees(m.marginPerKg)}</div>
          </div>
        </div>
      </div>

      {/* Composition bar */}
      <div className="px-4 pt-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Where the revenue goes</span>
          <span className="font-mono text-[11px] font-semibold tabular-nums text-foreground/70">{rupees(m.revenue)} revenue</span>
        </div>
        <div className="flex h-3.5 w-full gap-0.5 overflow-hidden rounded-full bg-muted">
          {segments.map((s) => (
            <div key={s.key} className={cn('h-full', s.color)} style={{ width: width(s.value) }} title={`${s.label}: ${rupees(s.value)}`} />
          ))}
        </div>
        <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
          {segments.map((s) => (
            <div key={s.key} className="flex items-center gap-1.5">
              <span className={cn('h-2 w-2 rounded-full', s.color)} />
              <span className="text-[10px] font-medium text-muted-foreground">{s.label}</span>
              <span className="font-mono text-[10px] font-semibold tabular-nums text-foreground/80">{rupees(s.value)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Cost tiles */}
      <div className="grid grid-cols-2 gap-2.5 px-4 py-4 sm:grid-cols-3 lg:grid-cols-4">
        <PnlTile accent="bg-sky-500" label="Sale price" value={`${rupees(m.ratePerKg)}/kg`} sub={`${rupees(m.revenue)} · incl. freight`} />
        <PnlTile accent="bg-slate-400" label="− Freight" value={`${rupees(m.freightPerKg)}/kg`} sub={`${rupees(m.freight)} netted out`} />
        {m.brokerage > 0 && <PnlTile accent="bg-violet-400" label="− Brokerage" value={rupees(m.brokerage)} />}
        <PnlTile accent="bg-indigo-500" label="= Net realisation" value={rupees(m.netRealization)} emphasis />
        <PnlTile accent="bg-amber-500" label="− Black seed cost" value={`${rupees(m.seedCostPerPappuKg)}/kg`} sub={`${rupees(m.seedCost)} · WAC ${rupees(m.seedWacPerKg)}/kg`} />
        {m.prodCost > 0 && <PnlTile accent="bg-orange-400" label="− Production" value={`${rupees(m.prodCostPerKg)}/kg`} sub={rupees(m.prodCost)} />}
        <PnlTile accent={isProfit ? 'bg-emerald-500' : 'bg-rose-500'} label={isProfit ? 'Net margin' : 'Net loss'} value={rupees(m.margin)} sub={`${m.marginPct.toFixed(1)}% · ${rupees(m.marginPerKg)}/kg`} emphasis valueClass={pnlText} />
      </div>

      {/* Date-aware seed allocation */}
      {m.seedBands.length > 0 && (
        <div className="border-t border-border/60 bg-muted/30 px-4 py-3">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Black seed allocated · date-aware (dearest available at sale date)</span>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {m.seedBands.map((b, i) => (
              <span key={i} className="inline-flex items-center gap-1.5 rounded-lg border border-amber-200/70 bg-amber-50 px-2.5 py-1 font-mono text-[10px] text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
                <span className="font-semibold">{toTonnes(b.seedKg).toFixed(2)}t</span>
                <span className="opacity-60">@</span>
                {rupees(b.price)}/kg
                <span className="opacity-60">=</span>
                {rupees(b.cost)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Accent-bordered figure tile used in the Pappu P/L panel. */
function PnlTile({ accent, label, value, sub, emphasis, valueClass }: {
  accent: string; label: string; value: string; sub?: string; emphasis?: boolean; valueClass?: string;
}) {
  return (
    <div className={cn('relative overflow-hidden rounded-xl border p-3', emphasis ? 'border-border bg-background shadow-sm' : 'border-border/60 bg-background/60')}>
      <span className={cn('absolute inset-y-0 left-0 w-1', accent)} />
      <div className="pl-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className={cn('mt-1 font-mono text-sm font-bold tabular-nums', valueClass)}>{value}</div>
        {sub && <div className="mt-0.5 font-mono text-[10px] text-muted-foreground/80">{sub}</div>}
      </div>
    </div>
  );
}
