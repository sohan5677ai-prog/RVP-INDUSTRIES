import { useMemo } from 'react';
import {
  LineChart as LineChartIcon, PieChart as PieChartIcon, TrendingUp,
  Layers, Scale, BarChart3, ShoppingCart, Wallet, Users,
} from 'lucide-react';
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';
import { kg, rupees } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { ChartCard } from '@/components/ChartCard';
import type { Account, Purchase, PurchaseOrder, SaleOrder, POStatus, SaleStatus } from '@/lib/types';

// ── Shared types (also imported by Dashboard) ────────────────────────
export interface Summary {
  pendingPOs: number;
  arrivedPOs: number;
  pendingSales: number;
  blackStockOnHandKg: number;
  pappuProducedKg: number;
  pappuDispatchedKg: number;
  pappuInventoryKg: number;
  supplierPayable: number;
}

export interface HuskExpenses {
  blackSeedUnloading: number;
  transferCosts: number;
  pappuLoading: number;
  pappuRoasting: number;
  huskLoading: number;
  tWasteLoading: number;
  bagCutting: number;
  pappuNet: number;
  huskPacking: number;
  tpsBrokensPacking: number;
  tamarindByproductsPacking: number;
  misc: number;
  gunnyBags: number;
  electricity: number;
  maintenance: number;
  miscExpense: number;
  storageElectricity: number;
  storageSalaries: number;
  drawingsShabri: number;
  drawingsReddy: number;
  ccInterest: number;
  termLoanInterest: number;
  loanInterestUnabsorbed: number;
  termLoanPrincipal: number;
}
export interface HuskPnl {
  revenue: number;
  expenses: HuskExpenses;
  totalExpenses: number;
  netRecovery: number;
}

export type PurchaseRow = Purchase & {
  netWeightKg: number;
  stockIn?: {
    arrivalDate?: string;
    billingWeightKg?: number;
    partyKataKg?: number;
    purchaseOrder?: { poNumber?: string; party?: { name: string } };
  };
};

// Display order + labels for the itemized husk-pool deductions.
const HUSK_EXPENSE_ROWS: { key: keyof HuskExpenses; label: string }[] = [
  { key: 'blackSeedUnloading', label: 'Black Seed Unloading' },
  { key: 'transferCosts', label: 'Stock Transfer Costs' },
  { key: 'pappuLoading', label: 'Pappu Loading' },
  { key: 'pappuRoasting', label: 'Pappu Roasting' },
  { key: 'huskLoading', label: 'Husk Loading' },
  { key: 'tWasteLoading', label: 'T-Waste Loading' },
  { key: 'bagCutting', label: 'Bag Cutting' },
  { key: 'pappuNet', label: 'Pappu Net (Rasi)' },
  { key: 'huskPacking', label: 'Husk Packing' },
  { key: 'tpsBrokensPacking', label: 'TPS Brokens Packing' },
  { key: 'tamarindByproductsPacking', label: 'Tamarind Byproducts Packing' },
  { key: 'misc', label: 'Miscellaneous' },
  { key: 'gunnyBags', label: 'Gunny Bags (net)' },
  { key: 'electricity', label: 'Electricity' },
  { key: 'maintenance', label: 'Maintenance' },
  { key: 'miscExpense', label: 'Miscellaneous Expenses' },
  { key: 'storageElectricity', label: 'Storage Electricity' },
  { key: 'storageSalaries', label: 'Storage Salaries' },
  { key: 'drawingsShabri', label: 'Drawings - Shabri' },
  { key: 'drawingsReddy', label: 'Drawings - Reddy' },
  { key: 'ccInterest', label: 'CC Interest' },
  { key: 'termLoanInterest', label: 'Term Loan Interest' },
  { key: 'loanInterestUnabsorbed', label: 'Loan Interest (unabsorbed)' },
  { key: 'termLoanPrincipal', label: 'Term Loan Principal' },
];

// Theme-aware colours - CSS vars adapt automatically to dark mode.
const C = {
  amber: 'var(--primary)',
  forest: 'var(--forest)',
  gold: 'var(--warning)',
  brick: 'var(--destructive)',
  grid: 'var(--border)',
  axis: 'var(--muted-foreground)',
};
const PIE_COLORS = ['var(--primary)', 'var(--forest)', 'var(--warning)', 'var(--destructive)'];

const inrCompact = (n: number) =>
  '₹' + new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
const tCompact = (kgVal: number) => `${((kgVal || 0) / 1000).toFixed(1)}t`;

function ChartTip({ active, payload, label, fmt }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 shadow-[var(--shadow-md)] text-xs min-w-[120px]">
      {label != null && <div className="font-semibold text-foreground mb-1">{label}</div>}
      {payload.map((e: any, i: number) => (
        <div key={i} className="flex items-center gap-2 py-0.5">
          <span className="h-2 w-2 rounded-full shrink-0" style={{ background: e.color || e.payload?.fill }} />
          <span className="text-muted-foreground">{e.name}</span>
          <span className="ml-auto font-mono font-medium text-foreground tabular-nums">
            {fmt ? fmt(e.value) : e.value}
          </span>
        </div>
      ))}
    </div>
  );
}

const axisTick = { fill: C.axis, fontSize: 11 };

interface Props {
  data: Summary;
  accounts?: Account[];
  purchases?: PurchaseRow[];
  poAll?: PurchaseOrder[];
  saleAll?: SaleOrder[];
  huskPnl?: HuskPnl;
}

export default function DashboardCharts({ data, accounts, purchases, poAll, saleAll, huskPnl }: Props) {
  // ── Monthly procurement spend + volume (last 8 months) ────────────
  const trend = useMemo(() => {
    const now = new Date();
    const months = Array.from({ length: 8 }, (_, k) => {
      const d = new Date(now.getFullYear(), now.getMonth() - (7 - k), 1);
      return { key: `${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleString('en-IN', { month: 'short' }), spend: 0, weight: 0, trips: 0 };
    });
    const idx = Object.fromEntries(months.map((m, i) => [m.key, i]));
    for (const p of purchases ?? []) {
      const d = new Date(p.stockIn?.arrivalDate || p.createdAt);
      const i = idx[`${d.getFullYear()}-${d.getMonth()}`];
      if (i != null) {
        months[i].spend += Number(p.verification?.totalAmount || 0);
        months[i].weight += Number(p.netWeightKg || 0);
        months[i].trips += 1;
      }
    }
    return months;
  }, [purchases]);

  // ── Profitability from ledger ─────────────────────────────────────
  const totalRevenue = accounts?.filter((a) => a.type === 'REVENUE').reduce((s, a) => s + a.balance, 0) ?? 0;
  const totalExpense = accounts?.filter((a) => a.type === 'EXPENSE').reduce((s, a) => s + a.balance, 0) ?? 0;
  const netProfit = totalRevenue - totalExpense;
  const margin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;
  const profitData = [
    { name: 'Revenue', value: totalRevenue, fill: C.forest },
    { name: 'Expense', value: totalExpense, fill: C.brick },
  ];

  // ── PO pipeline by status ─────────────────────────────────────────
  const poStatusColor: Record<POStatus, string> = { PENDING: C.gold, ARRIVED: C.amber, COMPLETED: C.forest, CANCELLED: C.brick };
  const poPipeline = (['PENDING', 'ARRIVED', 'COMPLETED', 'CANCELLED'] as POStatus[])
    .map((s) => ({ status: s[0] + s.slice(1).toLowerCase(), key: s, count: poAll?.filter((p) => p.status === s).length ?? 0 }));

  // ── Sales fulfilment by status ────────────────────────────────────
  const salePipeline = (['PENDING', 'PARTIAL', 'DISPATCHED', 'DELIVERED'] as SaleStatus[])
    .map((s) => ({ name: s[0] + s.slice(1).toLowerCase(), value: saleAll?.filter((o) => o.status === s).length ?? 0 }))
    .filter((d) => d.value > 0);

  // ── Stock composition ─────────────────────────────────────────────
  const stockComposition = data ? [
    { name: 'Black seed on hand', value: Math.round(data.blackStockOnHandKg) },
    { name: 'Pappu inventory', value: Math.round(data.pappuInventoryKg) },
    { name: 'Pappu dispatched', value: Math.round(data.pappuDispatchedKg) },
  ].filter((d) => d.value > 0) : [];

  // ── Supplier stats: volume + shortage / trust ─────────────────────
  const supplierStats = useMemo(() => {
    const map: Record<string, { name: string; count: number; billing: number; rvp: number; shortage: number }> = {};
    for (const p of purchases ?? []) {
      const name = p.stockIn?.purchaseOrder?.party?.name;
      if (!name) continue;
      map[name] ??= { name, count: 0, billing: 0, rvp: 0, shortage: 0 };
      const billing = p.stockIn?.billingWeightKg ?? 0;
      const rvp = p.netWeightKg ?? 0;
      map[name].count += 1;
      map[name].billing += billing;
      map[name].rvp += rvp;
      map[name].shortage += Math.max(0, billing - rvp);
    }
    return Object.values(map);
  }, [purchases]);

  const topSuppliers = [...supplierStats].sort((a, b) => b.rvp - a.rvp).slice(0, 6)
    .map((s) => ({ name: s.name.length > 16 ? s.name.slice(0, 15) + '…' : s.name, value: Math.round(s.rvp) }));

  const topBuyersList = useMemo(() => {
    const map: Record<string, { name: string; count: number; ordered: number; dispatched: number }> = {};
    for (const o of saleAll ?? []) {
      const name = o.buyer?.name;
      if (!name) continue;
      map[name] ??= { name, count: 0, ordered: 0, dispatched: 0 };
      map[name].count += 1;
      map[name].ordered += o.tonnageKg;
      map[name].dispatched += o.dispatchedKg ?? 0;
    }
    return Object.values(map)
      .map(b => ({ ...b, remaining: Math.max(0, b.ordered - b.dispatched), fulfilPct: b.ordered > 0 ? (b.dispatched / b.ordered) * 100 : 0 }))
      .sort((a, b) => b.dispatched - a.dispatched)
      .slice(0, 10);
  }, [saleAll]);

  // ── Weight reconciliation totals ──────────────────────────────────
  const recon = useMemo(() => {
    let billing = 0, party = 0, rvp = 0;
    for (const p of purchases ?? []) {
      billing += p.stockIn?.billingWeightKg ?? 0;
      party += p.stockIn?.partyKataKg ?? 0;
      rvp += p.netWeightKg ?? 0;
    }
    return [
      { name: 'Invoice billing', value: Math.round(billing), fill: C.gold },
      { name: 'Party kata', value: Math.round(party), fill: C.amber },
      { name: 'RVP kata', value: Math.round(rvp), fill: C.forest },
    ];
  }, [purchases]);

  return (
    <div className="space-y-7">
      {/* Row: procurement trend + stock composition */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <ChartCard className="lg:col-span-2" title="Procurement spend" subtitle="Verified payable by month (last 8)" icon={LineChartIcon}
          right={<span className="font-mono text-xs text-muted-foreground">{inrCompact(trend.reduce((s, m) => s + m.spend, 0))} total</span>}>
          <ResponsiveContainer width="100%" height={250}>
            <AreaChart data={trend} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
              <defs>
                <linearGradient id="gSpend" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={C.amber} stopOpacity={0.32} />
                  <stop offset="100%" stopColor={C.amber} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={C.grid} vertical={false} />
              <XAxis dataKey="label" tick={axisTick} axisLine={false} tickLine={false} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} width={48} tickFormatter={inrCompact} />
              <Tooltip content={<ChartTip fmt={rupees} />} cursor={{ stroke: C.amber, strokeOpacity: 0.3 }} />
              <Area type="monotone" dataKey="spend" name="Spend" stroke={C.amber} strokeWidth={2.5} fill="url(#gSpend)" dot={{ r: 2.5, fill: C.amber }} activeDot={{ r: 4 }} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Stock composition" subtitle="Seed & pappu balance (kg)" icon={PieChartIcon}>
          {stockComposition.length === 0 ? (
            <EmptyChart />
          ) : (
            <ResponsiveContainer width="100%" height={250}>
              <PieChart>
                <Pie data={stockComposition} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={52} outerRadius={82} paddingAngle={2} stroke="var(--card)" strokeWidth={2}>
                  {stockComposition.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Pie>
                <Tooltip content={<ChartTip fmt={kg} />} />
              </PieChart>
            </ResponsiveContainer>
          )}
          <Legend items={stockComposition.map((d, i) => ({ label: d.name, color: PIE_COLORS[i % PIE_COLORS.length] }))} />
        </ChartCard>
      </div>

      {/* Row: PO pipeline + sales fulfilment + profit */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <ChartCard title="PO pipeline" subtitle="Purchase orders by status" icon={Layers}>
          <ResponsiveContainer width="100%" height={210}>
            <BarChart data={poPipeline} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.grid} vertical={false} />
              <XAxis dataKey="status" tick={axisTick} axisLine={false} tickLine={false} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} allowDecimals={false} width={28} />
              <Tooltip content={<ChartTip />} cursor={{ fill: C.amber, fillOpacity: 0.06 }} />
              <Bar dataKey="count" name="Orders" radius={[6, 6, 0, 0]} maxBarSize={48}>
                {poPipeline.map((d, i) => <Cell key={i} fill={poStatusColor[d.key]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Sales fulfilment" subtitle="Sale orders by stage" icon={ShoppingCart}>
          {salePipeline.length === 0 ? <EmptyChart /> : (
            <ResponsiveContainer width="100%" height={210}>
              <PieChart>
                <Pie data={salePipeline} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} paddingAngle={2} stroke="var(--card)" strokeWidth={2}>
                  {salePipeline.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Pie>
                <Tooltip content={<ChartTip />} />
              </PieChart>
            </ResponsiveContainer>
          )}
          <Legend items={salePipeline.map((d, i) => ({ label: d.name, color: PIE_COLORS[i % PIE_COLORS.length] }))} />
        </ChartCard>

        <ChartCard title="Profitability" subtitle="Accrued from the ledger" icon={TrendingUp}>
          <div className="px-3 pt-1">
            <div className="text-[11px] text-muted-foreground">Net profit (accrued)</div>
            <div className={`font-mono text-3xl font-medium tracking-tight tabular-nums mt-0.5 ${netProfit >= 0 ? 'text-forest' : 'text-destructive'}`}>
              {rupees(netProfit)}
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5">Margin {margin.toFixed(1)}%</div>
          </div>
          <ResponsiveContainer width="100%" height={120}>
            <BarChart data={profitData} layout="vertical" margin={{ top: 8, right: 12, left: 8, bottom: 0 }}>
              <XAxis type="number" hide tickFormatter={inrCompact} />
              <YAxis type="category" dataKey="name" tick={axisTick} axisLine={false} tickLine={false} width={62} />
              <Tooltip content={<ChartTip fmt={rupees} />} cursor={{ fill: C.amber, fillOpacity: 0.06 }} />
              <Bar dataKey="value" radius={[0, 6, 6, 0]} maxBarSize={26}>
                {profitData.map((d, i) => <Cell key={i} fill={d.fill} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Row: Husk Profit & Loss Module */}
      <div className="grid grid-cols-1 gap-5">
        <ChartCard title="Husk Profit & Loss" subtitle="Are husk sales covering factory operations?" icon={Wallet} iconClass="bg-emerald-50 text-emerald-600 dark:bg-emerald-950/20">
          <div className="grid md:grid-cols-3 gap-8 p-3">
            <div className="space-y-6">
              <div>
                <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Pooled Byproduct Sales (Husk + T-Waste + TPS)</div>
                <div className="text-3xl font-bold tracking-tight text-forest">{rupees(huskPnl?.revenue ?? 0)}</div>
              </div>
              <div>
                <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Net Recovery</div>
                <div className={`text-2xl font-bold tracking-tight ${(huskPnl?.netRecovery ?? 0) >= 0 ? 'text-forest' : 'text-destructive'}`}>
                  {rupees(huskPnl?.netRecovery ?? 0)}
                </div>
              </div>
            </div>

            <div className="md:col-span-2">
              <div className="flex items-center justify-between mb-4">
                <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Pooled Operational Expenses</span>
                <span className="font-mono text-xs text-muted-foreground">{rupees(huskPnl?.totalExpenses ?? 0)} total</span>
              </div>
              <div className="space-y-3">
                {HUSK_EXPENSE_ROWS.map((row) => (
                  <ExpenseBar
                    key={row.key}
                    label={row.label}
                    value={huskPnl?.expenses?.[row.key] ?? 0}
                    max={huskPnl?.totalExpenses ?? 1}
                  />
                ))}
              </div>
            </div>
          </div>
        </ChartCard>
      </div>

      {/* Row: top suppliers + weight reconciliation */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <ChartCard className="lg:col-span-2" title="Top suppliers by volume" subtitle="RVP net weight received" icon={BarChart3}>
          {topSuppliers.length === 0 ? <EmptyChart /> : (
            <ResponsiveContainer width="100%" height={Math.max(180, topSuppliers.length * 38)}>
              <BarChart data={topSuppliers} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.grid} horizontal={false} />
                <XAxis type="number" tick={axisTick} axisLine={false} tickLine={false} tickFormatter={tCompact} />
                <YAxis type="category" dataKey="name" tick={axisTick} axisLine={false} tickLine={false} width={120} />
                <Tooltip content={<ChartTip fmt={kg} />} cursor={{ fill: C.amber, fillOpacity: 0.06 }} />
                <Bar dataKey="value" name="Received" fill={C.amber} radius={[0, 6, 6, 0]} maxBarSize={22} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        <ChartCard title="Weight reconciliation" subtitle="Billing vs party vs RVP kata" icon={Scale}>
          <ResponsiveContainer width="100%" height={210}>
            <BarChart data={recon} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.grid} vertical={false} />
              <XAxis dataKey="name" tick={{ ...axisTick, fontSize: 10 }} axisLine={false} tickLine={false} interval={0} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} width={36} tickFormatter={tCompact} />
              <Tooltip content={<ChartTip fmt={kg} />} cursor={{ fill: C.amber, fillOpacity: 0.06 }} />
              <Bar dataKey="value" name="Weight" radius={[6, 6, 0, 0]} maxBarSize={46}>
                {recon.map((d, i) => <Cell key={i} fill={d.fill} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Top Buyers by Volume */}
      <ChartCard title="Top buyers by volume" subtitle="Top 10 buyers by dispatched weight" icon={Users} iconClass="bg-blue-50 text-blue-600 dark:bg-blue-950/20">
        <div className="px-3 pb-1 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                <th className="text-left py-2 font-semibold">Buyer</th>
                <th className="text-right py-2 font-semibold">Orders</th>
                <th className="text-right py-2 font-semibold">Ordered</th>
                <th className="text-right py-2 font-semibold">Dispatched</th>
                <th className="text-right py-2 font-semibold">Remaining</th>
                <th className="text-right py-2 font-semibold">Fulfilment</th>
              </tr>
            </thead>
            <tbody>
              {topBuyersList.length === 0 ? (
                <tr><td colSpan={6} className="text-center text-muted-foreground py-6">No verified sale records.</td></tr>
              ) : topBuyersList.map((b) => (
                <tr key={b.name} className="border-b border-border/60 last:border-0 hover:bg-accent/40 transition-colors">
                  <td className="py-2.5 font-medium text-foreground">{b.name}</td>
                  <td className="py-2.5 text-right font-mono tabular-nums">{b.count}</td>
                  <td className="py-2.5 text-right font-mono tabular-nums">{kg(b.ordered)}</td>
                  <td className="py-2.5 text-right font-mono tabular-nums text-forest">{kg(b.dispatched)}</td>
                  <td className="py-2.5 text-right font-mono tabular-nums text-muted-foreground">{kg(b.remaining)}</td>
                  <td className="py-2.5 text-right">
                    <Badge variant={b.fulfilPct >= 100 ? 'success' : 'secondary'}>{b.fulfilPct.toFixed(0)}%</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ChartCard>
    </div>
  );
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  if (!items.length) return null;
  return (
    <div className="mt-4 flex flex-wrap justify-center gap-x-5 gap-y-2 px-4">
      {items.map((it) => (
        <div key={it.label} className="flex items-center gap-2">
          <div className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: it.color }} />
          <span className="text-xs text-muted-foreground">{it.label}</span>
        </div>
      ))}
    </div>
  );
}

function ExpenseBar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div>
      <div className="flex justify-between items-center text-xs mb-1.5">
        <span className="font-medium text-muted-foreground">{label}</span>
        <span className="font-mono text-foreground font-medium">{rupees(value)}</span>
      </div>
      <div className="h-2 bg-muted/60 rounded-full overflow-hidden">
        <div className="h-full bg-rose-500 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function EmptyChart() {
  return (
    <div className="flex h-[210px] items-center justify-center text-sm text-muted-foreground">
      No data yet.
    </div>
  );
}
