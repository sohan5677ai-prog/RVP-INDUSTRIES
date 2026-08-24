import { Fragment, useMemo, useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  TrendingUp, TrendingDown, IndianRupee, PackageCheck, Scale, Percent, ChevronRight, Trophy,
  AlertTriangle, Lock, LockOpen, Truck, Wheat, Target, Medal, SlidersHorizontal, RotateCcw,
  ArrowUpRight, ArrowDownRight, MapPin, Layers, RefreshCw,
} from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { rupees, rupeesShort, shortDate, toTonnes } from '@/lib/format';
import {
  Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/PageHeader';
import { Segmented } from '@/components/ui/segmented';
import { Combobox } from '@/components/ui/combobox';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from 'sonner';
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
  seedKg: number;
  seedCost: number;
  seedWacPerKg: number;
  seedCostPerPappuKg: number;
  netRealization: number;
  margin: number;
  marginPerKg: number;
  marginPct: number;
  seedBands: { price: number; seedKg: number; cost: number }[];
  /** Pappu dispatched as XS (excess out) - zero seed cost, so margin % is not a rate benchmark. */
  excessOutKg: number;
  unbackedPappuKg: number;
  /** Set once the order is fully shipped: costs are pinned and can no longer move. */
  costFrozenAt: string | null;
}

/** Peer averages over the currently-filtered orders, used to score one order. */
interface Bench {
  count: number;
  rank: Map<string, number>;
  avgRatePerKg: number;
  avgFreightPerKg: number;
  avgSeedPerKg: number;
  avgMarginPerKg: number;
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
  const qc = useQueryClient();
  const { data: margins, isLoading } = useQuery({
    queryKey: ['pappu-margins'],
    queryFn: () => api<PappuMargin[]>('/inventory/pappu-margins'),
  });

  const resyncMutation = useMutation({
    mutationFn: () => api<{ message?: string; count?: number }>('/inventory/resync-pappu-costs', { method: 'POST' }),
    onSuccess: (res) => {
      ['pappu-margins', 'profit-loss', 'dashboard', 'stock-by-price', 'sale-orders'].forEach((k) =>
        qc.invalidateQueries({ queryKey: [k] }),
      );
      toast.success(res?.message || 'Seed costs and profit margins re-synchronized successfully!');
    },
    onError: (e: Error) => toast.error(getErrorMessage(e) || 'Failed to re-sync costs'),
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
  /** Visible width of the scroller - the expanded panel is pinned to it so it never scrolls off. */
  const [tableViewWidth, setTableViewWidth] = useState(0);

  // Set up synchronized scrolling and width observation
  useEffect(() => {
    const topScroller = topScrollRef.current;
    const tableScroller = wrapperRef.current?.querySelector('[data-slot="table-container"]') as HTMLDivElement;
    if (!topScroller || !tableScroller) return;

    const updateWidth = () => {
      setTableScrollWidth(tableScroller.scrollWidth);
      setTableViewWidth(tableScroller.clientWidth);
    };
    updateWidth();

    const observer = new ResizeObserver(updateWidth);
    observer.observe(tableScroller);
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
    // `expanded` matters: opening a panel can add the vertical scrollbar, which
    // shrinks clientWidth without changing the observed border-box size.
  }, [margins, profitFilter, buyerFilter, fromDate, toDate, sortKey, expanded]);

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
    const seedCost = sum((m) => m.seedCost);
    const margin = sum((m) => m.margin);
    const lockedOrders = visible.filter((m) => m.costFrozenAt != null);
    const lockedMargin = lockedOrders.reduce((s, m) => s + m.margin, 0);
    const lockedRevenue = lockedOrders.reduce((s, m) => s + m.revenue, 0);
    const lockedMarginPct = lockedRevenue > 0 ? (lockedMargin / lockedRevenue) * 100 : 0;

    const profitOrders = visible.filter((m) => m.margin >= 0);
    const lossOrders = visible.filter((m) => m.margin < 0);
    const best = visible.reduce<PappuMargin | null>((b, m) => (!b || m.margin > b.margin ? m : b), null);
    const worst = visible.reduce<PappuMargin | null>((w, m) => (!w || m.margin < w.margin ? m : w), null);

    // Implied ACTUAL out-turn. Every XS tonne asserts the mill yielded more than
    // the assumed 60%, so cumulative XS against seed consumed reveals the yield
    // we have really been running at. A figure close to 60% is healthy; one that
    // keeps climbing means the XS tick is papering over a counting problem
    // (short-weighed lorry, double-counted bags) rather than real surplus.
    const xsKg = sum((m) => m.excessOutKg);
    const seedKg = sum((m) => m.seedKg);
    const impliedOutTurnPct = seedKg > 0 ? ((seedKg * 0.6 + xsKg) / seedKg) * 100 : 0;

    return {
      xsKg, impliedOutTurnPct,
      soldKg, revenue, freight, seedCost, margin,
      lockedMargin, lockedCount: lockedOrders.length, lockedMarginPct,
      netRealization: sum((m) => m.netRealization),
      totalCost: freight + seedCost,
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

  // ── Peer benchmark: every expanded order is scored against the filtered set ──
  const bench = useMemo<Bench>(() => {
    const ranked = [...visible].sort((a, b) => b.marginPerKg - a.marginPerKg);
    const rank = new Map<string, number>();
    ranked.forEach((r, i) => rank.set(r.orderId, i + 1));
    return {
      count: visible.length,
      rank,
      avgRatePerKg: t.avgSalePerKg,
      avgFreightPerKg: t.soldKg > 0 ? t.freight / t.soldKg : 0,
      avgSeedPerKg: t.seedCostPerKg,
      avgMarginPerKg: t.marginPerKg,
    };
  }, [visible, t]);

  const filtersActive = profitFilter !== 'ALL' || buyerFilter !== 'ALL' || !!fromDate || !!toDate;
  const pnlClass = (v: number) => (v >= 0 ? 'text-forest' : 'text-destructive');

  return (
    <div className="space-y-6">
      <PageHeader
        icon={TrendingUp}
        title="Pappu Profit & Loss"
        description="Order-by-order profitability of every Pappu sale - revenue net of freight, less the date-aware black-seed cost and production cost that actually backed each order. Brokerage is booked separately, dispatch-gated, in the Husk Pool overheads."
        actions={
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => resyncMutation.mutate()}
            disabled={resyncMutation.isPending}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", resyncMutation.isPending && "animate-spin")} />
            {resyncMutation.isPending ? 'Syncing...' : 'Re-sync Costs'}
          </Button>
        }
      />

      {/* Headline metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
              <Lock className="h-3.5 w-3.5 text-indigo-500" /> Locked Profit
            </CardTitle>
            {t.lockedMargin >= 0 ? <TrendingUp className="h-4 w-4 text-emerald-500" /> : <TrendingDown className="h-4 w-4 text-rose-500" />}
          </CardHeader>
          <CardContent>
            <div className={cn('text-2xl font-bold', pnlClass(t.lockedMargin))}>{rupees(t.lockedMargin)}</div>
            <p className="text-[10px] text-muted-foreground mt-1">{t.lockedCount} locked order{t.lockedCount === 1 ? '' : 's'} · {t.lockedMarginPct.toFixed(2)}% margin</p>
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
            <p className="text-[10px] text-muted-foreground mt-1">Seed + production + freight</p>
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
        <MiniStat icon={TrendingUp} label="Profitable orders" value={`${t.profitCount}`} sub={`of ${t.orders}`} valueClass="text-forest" />
        <MiniStat icon={TrendingDown} label="Loss orders" value={`${t.lossCount}`} sub={t.lossValue < 0 ? rupeesShort(t.lossValue) : '-'} valueClass="text-destructive" />
        <MiniStat icon={Scale} label="Black seed cost" value={rupeesShort(t.seedCost)} sub={`${rupees(t.seedCostPerKg)}/kg pappu`} />
        <MiniStat icon={Trophy} label="Best order" value={t.best ? rupeesShort(t.best.margin) : '-'} sub={t.best?.buyer} valueClass="text-forest" />
        <MiniStat icon={AlertTriangle} label="Worst order" value={t.worst ? rupeesShort(t.worst.margin) : '-'} sub={t.worst?.buyer} valueClass={t.worst && t.worst.margin < 0 ? 'text-destructive' : undefined} />
        {t.xsKg > 0 && (
          <MiniStat
            icon={Percent}
            label="Implied out-turn"
            value={`${t.impliedOutTurnPct.toFixed(2)}%`}
            sub={`${toTonnes(t.xsKg).toFixed(2)} t XS · 60% assumed`}
            valueClass={t.impliedOutTurnPct > 63 ? 'text-warning' : undefined}
          />
        )}
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
              <TableHead className="text-right">Seed cost</TableHead>
              <TableHead className="text-right">Net P/L</TableHead>
              <TableHead className="text-right">₹/kg</TableHead>
              <TableHead className="text-right">Margin %</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && <TableRow><TableCell colSpan={11} className="h-24 text-center text-muted-foreground">Loading…</TableCell></TableRow>}
            {!isLoading && visible.length === 0 && (
              <TableRow><TableCell colSpan={11} className="h-28 text-center text-muted-foreground">No Pappu orders matching filters.</TableCell></TableRow>
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
                        {m.costFrozenAt ? (
                          <span title="Fully shipped - seed, freight and production cost are pinned to what backed this order. Later purchases, verifications or rate changes cannot move it.">
                            <Lock className="h-3 w-3 shrink-0 text-muted-foreground/70" aria-label="Costs frozen" />
                          </span>
                        ) : (
                          <span title="Still open - this margin is a projection and will move as stock arrives. It freezes when the order is fully dispatched.">
                            <LockOpen className="h-3 w-3 shrink-0 text-amber-500/70" aria-label="Costs still live" />
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="font-medium text-foreground">
                      <div className="flex items-center gap-2">
                        <span>{m.buyer}</span>
                        {m.excessOutKg > 0 && (
                          <Badge
                            variant="warning"
                            className="shrink-0"
                            title={`${toTonnes(m.excessOutKg).toFixed(2)} t dispatched from yield surplus. Seed cost is nil on that tonnage (already recovered over the assumed 60% out-turn), so the margin % here is not a rate benchmark.`}
                          >
                            XS {toTonnes(m.excessOutKg).toFixed(2)}t
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{m.destination ?? '-'}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{toTonnes(m.orderedKg).toFixed(2)} t</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{rupees(m.ratePerKg)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{rupees(m.revenue)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-muted-foreground">{rupees(m.freight)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-muted-foreground">{rupees(m.seedCost)}</TableCell>
                    
                    <TableCell className={cn('text-right font-mono tabular-nums font-semibold', pnlClass(m.margin))}>{rupees(m.margin)}</TableCell>
                    <TableCell className={cn('text-right font-mono tabular-nums', pnlClass(m.margin))}>{rupees(m.marginPerKg)}</TableCell>
                    <TableCell className="text-right">
                      <Badge variant={m.margin >= 0 ? 'success' : 'warning'} className={m.margin < 0 ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-400' : undefined}>
                        {m.marginPct.toFixed(1)}%
                      </Badge>
                    </TableCell>
                  </TableRow>

                  {/* Expanded breakdown - pinned to the viewport so it never scrolls
                      off sideways with the (much wider) table body. */}
                  {isOpen && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={11} className="p-0">
                        <div className="sticky left-0" style={{ width: tableViewWidth || '100%' }}>
                          <div className="border-t border-border/60 bg-[color-mix(in_srgb,var(--muted)_45%,transparent)] px-4 py-4 sm:px-5">
                            <PappuMarginPanel m={m} bench={bench} />
                          </div>
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
                <TableCell className="text-right font-mono tabular-nums text-muted-foreground">{rupees(t.seedCost)}</TableCell>
                
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
 * Rich per-order Pappu P/L panel shown inside the expanded row.
 *
 * Four readings of the same order, in the house palette (tamarind amber = seed,
 * taupe = freight, forest = margin):
 *   1. a headline strip with the P/L, its rank among the filtered orders and status,
 *   2. a revenue-bridge waterfall - hand-rolled so it costs no chart bundle,
 *   3. the per-kg arithmetic as an editorial ledger + a break-even meter,
 *   4. benchmark deltas against the peer average, a live sale-rate what-if, and the
 *      date-aware black-seed bands.
 */
function PappuMarginPanel({ m, bench }: { m: PappuMargin; bench: Bench }) {
  const isProfit = m.margin >= 0;
  const pnlText = isProfit ? 'text-forest' : 'text-destructive';
  const barCls = isProfit ? 'bg-forest' : 'bg-destructive';

  const netPerKg = m.ratePerKg - m.freightPerKg;
  const breakEvenPerKg = m.freightPerKg + m.seedCostPerPappuKg;
  const rank = bench.rank.get(m.orderId);

  // ── Live sale-rate what-if. Every ₹1/kg moves the P/L by exactly the tonnage. ──
  const [simRate, setSimRate] = useState(m.ratePerKg);
  const simMargin = simRate * m.orderedKg - m.freight - m.seedCost;
  const simDelta = simMargin - m.margin;
  const simDirty = Math.abs(simRate - m.ratePerKg) > 0.001;
  const simPct = simRate * m.orderedKg > 0 ? (simMargin / (simRate * m.orderedKg)) * 100 : 0;
  const simMin = Math.max(0, Math.min(m.ratePerKg, breakEvenPerKg) - 3);
  const simMax = Math.max(m.ratePerKg, breakEvenPerKg) + 3;

  // ── Revenue bridge. Bars are drawn against a shared value axis so the drop from
  //    revenue to net profit is literally to scale. ──────────────────────────────
  const steps = [
    { key: 'rev', label: 'Revenue', icon: IndianRupee, amount: m.revenue, from: 0, to: m.revenue, cls: 'bg-foreground/70', per: m.ratePerKg },
    { key: 'frt', label: 'Freight', icon: Truck, amount: -m.freight, from: m.revenue - m.freight, to: m.revenue, cls: 'bg-muted-foreground/55', per: m.freightPerKg },
    { key: 'seed', label: 'Black seed', icon: Wheat, amount: -m.seedCost, from: m.margin, to: m.revenue - m.freight, cls: 'bg-primary', per: m.seedCostPerPappuKg },
    { key: 'net', label: isProfit ? 'Net profit' : 'Net loss', icon: isProfit ? TrendingUp : TrendingDown, amount: m.margin, from: Math.min(0, m.margin), to: Math.max(0, m.margin), cls: barCls, per: m.marginPerKg },
  ];
  const axisTop = Math.max(m.revenue, 0);
  const axisBottom = Math.min(0, m.margin);
  const span = axisTop - axisBottom || 1;
  const yPct = (v: number) => ((axisTop - v) / span) * 100;
  /** Running totals the dashed connectors sit on, one per gap between bars. */
  const bridgeLevels = [m.revenue, m.revenue - m.freight, m.margin];

  // Seed bands, dearest first, sized by their share of the seed spend.
  const bandTotal = m.seedBands.reduce((s, b) => s + b.cost, 0) || 1;
  const bandShades = ['bg-primary', 'bg-primary/75', 'bg-primary/55', 'bg-primary/40', 'bg-primary/28'];

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-md)]">
      {/* ── Headline ─────────────────────────────────────────────────────────── */}
      <div
        className={cn(
          'flex flex-wrap items-center justify-between gap-4 border-b border-border/70 px-4 py-3.5 sm:px-5',
          isProfit
            ? 'bg-[linear-gradient(100deg,color-mix(in_srgb,var(--forest)_13%,transparent),transparent_62%)]'
            : 'bg-[linear-gradient(100deg,color-mix(in_srgb,var(--destructive)_13%,transparent),transparent_62%)]',
        )}
      >
        <div className="flex items-center gap-3.5">
          <div className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-card', barCls, 'shadow-[var(--shadow-sm)]')}>
            {isProfit ? <TrendingUp className="h-5 w-5" /> : <TrendingDown className="h-5 w-5" />}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
              <span className="font-display text-sm font-semibold tracking-tight text-foreground">{m.buyer}</span>
              <span className="opacity-40">·</span>
              <span>{shortDate(m.saleDate)}</span>
              {m.destination && (
                <>
                  <span className="opacity-40">·</span>
                  <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" />{m.destination}</span>
                </>
              )}
              <span className="opacity-40">·</span>
              <span className="font-mono tabular-nums">{toTonnes(m.orderedKg).toFixed(2)} t</span>
            </div>
            <div className={cn('font-mono text-[26px] font-extrabold leading-tight tracking-tight tabular-nums', pnlText)}>
              {isProfit ? '+' : ''}{rupees(m.margin)}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-stretch gap-2">
          <HeadFigure label="Margin" value={`${m.marginPct.toFixed(2)}%`} valueClass={pnlText} />
          <HeadFigure label="Per kg" value={`${rupees(m.marginPerKg)}`} valueClass={pnlText} />
          {rank && (
            <HeadFigure
              label="Rank ₹/kg"
              value={`#${rank}`}
              sub={`of ${bench.count}`}
              valueClass={rank <= Math.max(1, Math.ceil(bench.count * 0.25)) ? 'text-forest' : undefined}
              icon={rank <= 3 ? Medal : undefined}
            />
          )}
          <div className="flex items-center">
            {m.costFrozenAt ? (
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-background/60 px-2.5 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground" title="Fully shipped - seed, freight and production cost are pinned to what backed this order.">
                <Lock className="h-3.5 w-3.5" /> Locked
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-warning/40 bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] px-2.5 py-2 text-[10px] font-semibold uppercase tracking-wider text-warning" title="Still open - this margin is a projection and will move as stock arrives.">
                <LockOpen className="h-3.5 w-3.5" /> Live
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ── Bridge chart + arithmetic ────────────────────────────────────────── */}
      <div className="grid gap-5 px-4 py-5 sm:px-5 lg:grid-cols-[1.05fr_1fr]">
        {/* Waterfall */}
        <section className="flex flex-col">
          <SectionLabel icon={Layers}>Revenue bridge · where every rupee lands</SectionLabel>
          <div className="mt-3 flex flex-1 flex-col rounded-xl border border-border/60 bg-background/50 px-3 pb-2 pt-7">
            <div className="relative min-h-40 flex-1">
              {/* zero rule, only meaningful when the order ran a loss */}
              {axisBottom < 0 && (
                <div className="absolute inset-x-0 border-t border-dashed border-border" style={{ top: `${yPct(0)}%` }} />
              )}

              {/* dashed connectors between running totals */}
              {bridgeLevels.map((lvl, i) => {
                const col = 100 / steps.length;
                const left = (i + 1) * col - col * 0.16;
                const width = col * 0.32;
                return (
                  <div
                    key={i}
                    className="absolute border-t border-dashed border-muted-foreground/40"
                    style={{ top: `${yPct(lvl)}%`, left: `${left}%`, width: `${width}%` }}
                  />
                );
              })}

              <div className="absolute inset-0 flex items-stretch">
                {steps.map((s) => {
                  const top = yPct(s.to);
                  const height = Math.max(((s.to - s.from) / span) * 100, 0.8);
                  return (
                    <div key={s.key} className="group relative flex-1">
                      <div
                        className={cn('absolute inset-x-[16%] rounded-[5px] transition-[filter,transform] duration-200 group-hover:brightness-110', s.cls)}
                        style={{ top: `${top}%`, height: `${height}%` }}
                        title={`${s.label}: ${rupees(Math.abs(s.amount))}`}
                      />
                      <span
                        className="absolute inset-x-0 text-center font-mono text-[10px] font-semibold tabular-nums text-foreground/80"
                        style={{ top: `calc(${top}% - 1.15rem)` }}
                      >
                        {s.amount < 0 ? '−' : ''}{rupeesShort(Math.abs(s.amount))}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* axis */}
            <div className="mt-2 flex border-t border-border/60 pt-2">
              {steps.map((s) => (
                <div key={s.key} className="flex-1 text-center">
                  <div className="flex items-center justify-center gap-1 text-[10px] font-medium text-muted-foreground">
                    <s.icon className="h-3 w-3" /> {s.label}
                  </div>
                  <div className="font-mono text-[10px] tabular-nums text-muted-foreground/70">{rupees(s.per)}/kg</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Arithmetic + break-even */}
        <section className="flex flex-col">
          <SectionLabel icon={Target}>How the ₹{m.ratePerKg.toFixed(2)}/kg breaks down</SectionLabel>
          <div className="mt-3 overflow-hidden rounded-xl border border-border/60 bg-background/50">
            <MathRow label="Sale price" accent="bg-foreground/70" perKg={m.ratePerKg} total={m.revenue} note="incl. freight" />
            <MathRow label="Freight" accent="bg-muted-foreground/55" perKg={-m.freightPerKg} total={-m.freight} note="netted out" />
            <MathRow label="Net realisation" accent="bg-transparent" perKg={netPerKg} total={m.netRealization} rule />
            <MathRow label="Black seed" accent="bg-primary" perKg={-m.seedCostPerPappuKg} total={-m.seedCost} note={`WAC ${rupees(m.seedWacPerKg)}/kg`} />
            <MathRow label={isProfit ? 'Net margin' : 'Net loss'} accent={barCls} perKg={m.marginPerKg} total={m.margin} rule emphasis valueClass={pnlText} />
          </div>

          {/* Break-even meter */}
          <div className="mt-3 rounded-xl border border-border/60 bg-background/50 px-3.5 py-3">
            <div className="flex items-baseline justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Break-even meter</span>
              <span className="font-mono text-[11px] font-semibold tabular-nums text-muted-foreground">
                needs {rupees(breakEvenPerKg)}/kg
              </span>
            </div>
            <div className="mt-2.5 flex h-3 w-full overflow-hidden rounded-full bg-muted">
              {[
                { k: 'seed', v: m.seedCostPerPappuKg, cls: 'bg-primary' },
                { k: 'frt', v: m.freightPerKg, cls: 'bg-muted-foreground/55' },
                { k: 'mrg', v: Math.max(m.marginPerKg, 0), cls: barCls },
              ].filter((s) => s.v > 0).map((s) => (
                <div key={s.k} className={cn('h-full', s.cls)} style={{ width: `${(s.v / Math.max(m.ratePerKg, breakEvenPerKg)) * 100}%` }} />
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              Sold at <span className="font-mono font-semibold text-foreground">{rupees(m.ratePerKg)}/kg</span> ·{' '}
              <span className={cn('font-mono font-semibold', pnlText)}>
                {isProfit ? `${rupees(m.marginPerKg)} above` : `${rupees(Math.abs(m.marginPerKg))} below`}
              </span>{' '}
              break-even. A ₹1/kg move on this order is worth{' '}
              <span className="font-mono font-semibold text-foreground">{rupeesShort(m.orderedKg)}</span>.
            </p>
          </div>
        </section>
      </div>

      {/* ── Benchmarks + what-if ─────────────────────────────────────────────── */}
      <div className="grid gap-5 border-t border-border/60 px-4 py-4 sm:px-5 lg:grid-cols-[1.05fr_1fr]">
        <section>
          <SectionLabel icon={Medal}>Against the other {Math.max(bench.count - 1, 0)} order{bench.count === 2 ? '' : 's'} on screen</SectionLabel>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <DeltaChip label="Sale ₹/kg" value={m.ratePerKg} avg={bench.avgRatePerKg} higherIsBetter />
            <DeltaChip label="Freight ₹/kg" value={m.freightPerKg} avg={bench.avgFreightPerKg} higherIsBetter={false} />
            <DeltaChip label="Seed ₹/kg" value={m.seedCostPerPappuKg} avg={bench.avgSeedPerKg} higherIsBetter={false} />
            <DeltaChip label="Margin ₹/kg" value={m.marginPerKg} avg={bench.avgMarginPerKg} higherIsBetter />
          </div>
          {(m.excessOutKg > 0 || m.unbackedPappuKg > 0) && (
            <div className="mt-2.5 flex flex-wrap gap-2">
              {m.excessOutKg > 0 && (
                <Badge variant="warning" title="Dispatched from yield surplus - seed cost is nil on that tonnage, so the margin % here is not a rate benchmark.">
                  {toTonnes(m.excessOutKg).toFixed(2)} t from yield surplus · nil seed cost
                </Badge>
              )}
              {m.unbackedPappuKg > 0 && (
                <Badge variant="warning" title="Pappu with no seed behind it yet - the cost of this tonnage is still to come.">
                  {toTonnes(m.unbackedPappuKg).toFixed(2)} t not yet backed by seed
                </Badge>
              )}
            </div>
          )}
        </section>

        <section>
          <div className="flex items-center justify-between">
            <SectionLabel icon={SlidersHorizontal}>What if the rate had been different?</SectionLabel>
            {simDirty && (
              <button
                type="button"
                onClick={() => setSimRate(m.ratePerKg)}
                className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
              >
                <RotateCcw className="h-3 w-3" /> Reset
              </button>
            )}
          </div>
          <div className="mt-3 rounded-xl border border-border/60 bg-background/50 px-3.5 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-mono text-lg font-bold tabular-nums text-foreground">{rupees(simRate)}<span className="text-xs font-medium text-muted-foreground">/kg</span></span>
              <span className="flex items-baseline gap-2">
                <span className={cn('font-mono text-lg font-bold tabular-nums', simMargin >= 0 ? 'text-forest' : 'text-destructive')}>
                  {simMargin >= 0 ? '+' : ''}{rupees(simMargin)}
                </span>
                <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{simPct.toFixed(2)}%</span>
              </span>
            </div>
            <input
              type="range"
              aria-label="Simulated sale rate per kg"
              min={simMin}
              max={simMax}
              step={0.05}
              value={simRate}
              onChange={(e) => setSimRate(Number(e.target.value))}
              className="mt-2.5 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted"
              style={{ accentColor: 'var(--primary)' }}
            />
            <div className="mt-1.5 flex justify-between font-mono text-[10px] tabular-nums text-muted-foreground/70">
              <span>{rupees(simMin)}</span>
              <span className={cn(simDirty ? 'font-semibold text-foreground' : 'opacity-0')}>
                {simDelta >= 0 ? '+' : '−'}{rupeesShort(Math.abs(simDelta))} vs actual
              </span>
              <span>{rupees(simMax)}</span>
            </div>
          </div>
        </section>
      </div>

      {/* ── Date-aware seed allocation ───────────────────────────────────────── */}
      {m.seedBands.length > 0 && (
        <div className="border-t border-border/60 bg-[color-mix(in_srgb,var(--muted)_55%,transparent)] px-4 py-3.5 sm:px-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <SectionLabel icon={Wheat}>Black seed allocated · dearest available at sale date</SectionLabel>
            <span className="font-mono text-[11px] font-semibold tabular-nums text-muted-foreground">
              {toTonnes(m.seedKg).toFixed(2)} t · {rupees(m.seedCost)}
            </span>
          </div>
          <div className="mt-2.5 flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-muted">
            {m.seedBands.map((b, i) => (
              <div key={i} className={cn('h-full', bandShades[i % bandShades.length])} style={{ width: `${(b.cost / bandTotal) * 100}%` }} title={`${rupees(b.price)}/kg`} />
            ))}
          </div>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {m.seedBands.map((b, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1.5 rounded-lg border border-primary/25 bg-[color-mix(in_srgb,var(--primary)_9%,transparent)] px-2.5 py-1 font-mono text-[10px] tabular-nums text-foreground/85"
              >
                <span className={cn('h-2 w-2 shrink-0 rounded-full', bandShades[i % bandShades.length])} />
                <span className="font-semibold">{toTonnes(b.seedKg).toFixed(2)} t</span>
                <span className="opacity-50">@</span>
                {rupees(b.price)}/kg
                <span className="opacity-50">=</span>
                <span className="font-semibold">{rupees(b.cost)}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Small mono figure in the panel headline strip. */
function HeadFigure({ label, value, sub, valueClass, icon: Icon }: {
  label: string; value: string; sub?: string; valueClass?: string;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-background/60 px-3 py-1.5 text-center">
      <div className="text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
      <div className={cn('flex items-center justify-center gap-1 font-mono text-sm font-bold tabular-nums', valueClass)}>
        {Icon && <Icon className="h-3.5 w-3.5" />}{value}
        {sub && <span className="text-[10px] font-medium text-muted-foreground">{sub}</span>}
      </div>
    </div>
  );
}

/** Uppercase section caption with a leading glyph. */
function SectionLabel({ icon: Icon, children }: { icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
      <Icon className="h-3.5 w-3.5 text-primary" /> {children}
    </div>
  );
}

/** One line of the per-kg arithmetic ledger. */
function MathRow({ label, accent, perKg, total, note, rule, emphasis, valueClass }: {
  label: string; accent: string; perKg: number; total: number;
  note?: string; rule?: boolean; emphasis?: boolean; valueClass?: string;
}) {
  const sign = perKg < 0 ? '−' : '';
  return (
    <div className={cn(
      'flex items-center gap-3 px-3.5 py-2',
      rule && 'border-t border-border/70',
      emphasis && 'bg-[color-mix(in_srgb,var(--muted)_50%,transparent)]',
    )}>
      <span className={cn('h-6 w-1 shrink-0 rounded-full', accent)} />
      <div className="min-w-0 flex-1">
        <div className={cn('truncate text-xs', emphasis ? 'font-semibold text-foreground' : 'text-muted-foreground')}>{label}</div>
        {note && <div className="truncate text-[10px] text-muted-foreground/70">{note}</div>}
      </div>
      <div className={cn('shrink-0 text-right font-mono text-xs tabular-nums', emphasis ? 'font-bold' : 'font-semibold', valueClass ?? 'text-foreground')}>
        {sign}{rupees(Math.abs(perKg))}<span className="text-[10px] font-normal text-muted-foreground">/kg</span>
      </div>
      <div className={cn('w-28 shrink-0 text-right font-mono text-xs tabular-nums', emphasis ? 'font-bold' : '', valueClass ?? 'text-muted-foreground')}>
        {sign}{rupees(Math.abs(total))}
      </div>
    </div>
  );
}

/** Value vs. peer-average chip; colour follows whether the gap is good news. */
function DeltaChip({ label, value, avg, higherIsBetter }: {
  label: string; value: number; avg: number; higherIsBetter: boolean;
}) {
  const diff = value - avg;
  const flat = Math.abs(diff) < 0.005;
  const good = higherIsBetter ? diff > 0 : diff < 0;
  const tone = flat ? 'text-muted-foreground' : good ? 'text-forest' : 'text-destructive';
  const Arrow = diff >= 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <div className="rounded-xl border border-border/60 bg-background/50 px-3 py-2">
      <div className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-mono text-sm font-bold tabular-nums text-foreground">{rupees(value)}</div>
      <div className={cn('flex items-center gap-0.5 font-mono text-[10px] tabular-nums', tone)}>
        {!flat && <Arrow className="h-3 w-3" />}
        {flat ? 'at average' : `${rupees(Math.abs(diff))} vs avg`}
      </div>
    </div>
  );
}
