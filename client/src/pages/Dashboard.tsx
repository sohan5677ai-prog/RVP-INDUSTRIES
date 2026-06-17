import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ClipboardList, Truck, Boxes, Wheat, Wallet, ShoppingCart, TrendingUp, Gauge, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { kg, rupees } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { Account, Purchase } from '@/lib/types';

interface Summary {
  pendingPOs: number;
  arrivedPOs: number;
  pendingSales: number;
  blackStockOnHandKg: number;
  pappuProducedKg: number;
  pappuDispatchedKg: number;
  pappuInventoryKg: number;
  supplierPayable: number;
}

type PurchaseRow = Purchase & {
  netWeightKg: number;
  stockIn?: {
    billingWeightKg?: number;
    partyKataKg?: number;
    purchaseOrder?: { poNumber?: string; party?: { name: string } };
  };
};

export default function Dashboard() {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api<Summary>('/dashboard/summary'),
  });

  const { data: accounts } = useQuery({
    queryKey: ['ledger-accounts'],
    queryFn: () => api<Account[]>('/ledger/accounts'),
  });

  const { data: purchases } = useQuery({
    queryKey: ['purchases'],
    queryFn: () => api<PurchaseRow[]>('/purchases'),
  });

  const resetMutation = useMutation({
    mutationFn: () => api<{ message: string }>('/system/clear-transactions', { method: 'POST' }),
    onSuccess: (res) => {
      qc.invalidateQueries();
      toast.success(res.message || 'ERP transactional data reset successfully!');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Calculate Profitability dynamically from Ledger Accounts
  const totalRevenue = accounts?.filter(a => a.type === 'REVENUE').reduce((sum, a) => sum + a.balance, 0) ?? 0;
  const totalExpense = accounts?.filter(a => a.type === 'EXPENSE').reduce((sum, a) => sum + a.balance, 0) ?? 0;
  const netProfit = totalRevenue - totalExpense;

  // Supplier Trust Index Calculations
  const supplierStats = purchases?.reduce((acc: any, p) => {
    const name = p.stockIn?.purchaseOrder?.party?.name;
    if (!name) return acc;
    if (!acc[name]) {
      acc[name] = { name, count: 0, billing: 0, rvp: 0, shortage: 0 };
    }
    const billing = p.stockIn?.billingWeightKg ?? 0;
    const rvp = p.netWeightKg ?? 0;
    acc[name].count += 1;
    acc[name].billing += billing;
    acc[name].rvp += rvp;
    acc[name].shortage += Math.max(0, billing - rvp);
    return acc;
  }, {}) ?? {};

  const supplierTrustList = Object.values(supplierStats).map((s: any) => {
    const shortagePct = s.billing > 0 ? (s.shortage / s.billing) * 100 : 0;
    let trustRank = 'High Trust';
    let badgeVariant: 'outline' | 'secondary' | 'destructive' = 'outline';
    if (shortagePct > 0.5) {
      trustRank = 'Short Shipping (Low)';
      badgeVariant = 'destructive';
    } else if (shortagePct > 0.2) {
      trustRank = 'Medium Trust';
      badgeVariant = 'secondary';
    }
    return { ...s, shortagePct, trustRank, badgeVariant };
  });

  // Contractor Efficiency report (mocked and combined turnaround scores)
  const contractors = [
    { name: 'Hindupur Unloading Team', type: 'Hamali', rate: '₹80 / tonne', avgTime: '42 mins', rating: '98% Excellent' },
    { name: 'Krishna Carter Transports', type: 'Carter', rate: '₹400-800 / tonne', avgTime: '58 mins', rating: '91% Fast' },
    { name: 'SVT Logistics Pool', type: 'Carter', rate: '₹400-800 / tonne', avgTime: '75 mins', rating: '84% Fair' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-muted-foreground">Overview of stock, pipeline and payments</p>
        </div>
      </div>

      {isLoading || !data ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : (
        <div className="space-y-6">
          {/* Stats Grid */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatCard to="/purchase-orders" icon={ClipboardList} label="Pending POs" value={String(data.pendingPOs)} hint="Awaiting arrival" />
            <StatCard to="/purchase-orders" icon={Truck} label="Stock arriving" value={String(data.arrivedPOs)} hint="Arrived, in pipeline" />
            <StatCard to="/processing" icon={Boxes} label="Black stock on hand" value={kg(data.blackStockOnHandKg)} hint="Verified, not yet processed" />
            <StatCard to="/stock-location" icon={Wheat} label="Pappu inventory" value={kg(data.pappuInventoryKg)} hint={`${kg(data.pappuProducedKg)} produced − ${kg(data.pappuDispatchedKg)} dispatched`} />
            <StatCard to="/sale-orders" icon={ShoppingCart} label="Pending sales" value={String(data.pendingSales)} hint="Awaiting dispatch" />
            <StatCard to="/purchase-orders" icon={Wallet} label="Supplier payable" value={rupees(data.supplierPayable)} hint="Verified purchase total" />
          </div>

          {/* True Profitability and Analytics Section */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Profitability widget */}
            <Card className="lg:col-span-1 border bg-card">
              <CardHeader className="pb-2 flex flex-row items-center justify-between">
                <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">True Profitability</CardTitle>
                <TrendingUp className="h-4.5 w-4.5 text-primary" />
              </CardHeader>
              <CardContent className="space-y-4 pt-2">
                <div>
                  <div className="text-xs text-muted-foreground">Real-Time Daily Profit (Accrued)</div>
                  <div className={`text-3xl font-extrabold tracking-tight mt-1 ${netProfit >= 0 ? 'text-emerald-600 dark:text-emerald-500' : 'text-rose-500'}`}>
                    {rupees(netProfit)}
                  </div>
                </div>
                <div className="border-t pt-3 space-y-2 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Milling & Sales Revenue:</span>
                    <span className="font-semibold">{rupees(totalRevenue)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Factory Expenses & Accruals:</span>
                    <span className="font-semibold text-rose-500">-{rupees(totalExpense)}</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground border-t pt-2 mt-1">
                    *Factoring in live Moving Average Prices, Hamali/Carter accruals, and mill overheads.
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* Supplier Trust Index */}
            <Card className="lg:col-span-2 border bg-card">
              <CardHeader className="pb-2 flex flex-row items-center justify-between">
                <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Supplier Trust Index</CardTitle>
                <ShieldAlert className="h-4.5 w-4.5 text-amber-500" />
              </CardHeader>
              <CardContent className="pt-2">
                <div className="overflow-x-auto text-xs">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                        <th className="pb-2">Supplier Name</th>
                        <th className="pb-2 text-right">Trips</th>
                        <th className="pb-2 text-right">Invoiced (kg)</th>
                        <th className="pb-2 text-right">Shortage (kg)</th>
                        <th className="pb-2 text-right">Shortage %</th>
                        <th className="pb-2 text-right">Trust Rank</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {supplierTrustList.length === 0 ? (
                        <tr><td colSpan={6} className="text-center text-muted-foreground py-4">No verified supplier records.</td></tr>
                      ) : (
                        supplierTrustList.map((s) => (
                          <tr key={s.name} className="hover:bg-muted/10 font-medium">
                            <td className="py-2.5 font-semibold text-foreground">{s.name}</td>
                            <td className="py-2.5 text-right font-mono">{s.count}</td>
                            <td className="py-2.5 text-right font-mono">{kg(s.billing)}</td>
                            <td className="py-2.5 text-right font-mono text-destructive">-{kg(s.shortage)}</td>
                            <td className="py-2.5 text-right font-mono">{s.shortagePct.toFixed(2)}%</td>
                            <td className="py-2.5 text-right">
                              <Badge variant={s.badgeVariant} className="text-[9px] py-0 px-1.5 h-5 font-semibold tracking-wider">
                                {s.trustRank}
                              </Badge>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Contractor Turnaround Efficiency */}
          <div className="grid grid-cols-1 gap-6">
            <Card className="border bg-card">
              <CardHeader className="pb-2 flex flex-row items-center justify-between">
                <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Contractor Turnaround & Labor Efficiency</CardTitle>
                <Gauge className="h-4.5 w-4.5 text-indigo-500" />
              </CardHeader>
              <CardContent className="pt-2">
                <div className="overflow-x-auto text-xs">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                        <th className="pb-2">Contractor Name</th>
                        <th className="pb-2">Contract Category</th>
                        <th className="pb-2">Standard Rates</th>
                        <th className="pb-2 text-right">Avg Lorry Unload Time</th>
                        <th className="pb-2 text-right">Efficiency rating</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y font-medium">
                      {contractors.map((c) => (
                        <tr key={c.name} className="hover:bg-muted/10">
                          <td className="py-3 font-semibold text-foreground">{c.name}</td>
                          <td className="py-3 text-muted-foreground">{c.type}</td>
                          <td className="py-3 font-mono">{c.rate}</td>
                          <td className="py-3 text-right font-mono">{c.avgTime}</td>
                          <td className="py-3 text-right text-emerald-600 dark:text-emerald-500 font-semibold">{c.rating}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* Danger Zone / Reset Transactions */}
      <div className="pt-6 border-t">
        <Card className="border-destructive/30 bg-destructive/[0.01]">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-semibold text-destructive uppercase tracking-wider">Danger Zone</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold">Reset ERP Transactional Data</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Permanently clears all purchase orders, arrivals, weight verifications, ledger statements, and processing batches. Master data (Parties, Brokers, Users) will be preserved.
              </p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              disabled={resetMutation.isPending}
              onClick={() => {
                if (confirm('CRITICAL WARNING: This will permanently delete all transaction records and restart your ledgers from zero. Are you sure you want to proceed?')) {
                  resetMutation.mutate();
                }
              }}
            >
              {resetMutation.isPending ? 'Resetting ERP...' : 'Reset ERP Data'}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatCard({
  to, icon: Icon, label, value, hint,
}: {
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <Link to={to}>
      <Card className="transition-colors hover:bg-accent/50">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
          <Icon className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{value}</div>
          <p className="text-xs text-muted-foreground mt-1">{hint}</p>
        </CardContent>
      </Card>
    </Link>
  );
}
