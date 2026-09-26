type Purchase = {
  createdAt: Date; netWeightKg: number;
  verification: { totalAmount: unknown } | null;
  stockIn: { arrivalDate: Date; billingWeightKg: number | null; partyKataKg: number | null;
    purchaseOrder: { party: { name: string } } };
};
type Sale = {
  status: string; closedAt: Date | null; tonnageKg: number; buyer: { name: string };
  dispatches: { weightKg: number; status: string }[];
};

/** Business dates use IST, independent of the server's deployment timezone. */
function monthOf(date: Date) {
  const ist = new Date(date.getTime() + 330 * 60_000);
  return { year: ist.getUTCFullYear(), month: ist.getUTCMonth() };
}

export function buildDashboardMetrics(purchases: Purchase[], sales: Sale[],
  purchaseCounts: { status: string; _count: { _all: number } }[], now = new Date()) {
  const current = monthOf(now);
  const trend: { key: string; label: string; spend: number; weight: number; trips: number }[] = [];
  for (let n = 2026 * 12 + 2; n <= current.year * 12 + current.month; n++) {
    const year = Math.floor(n / 12), month = n % 12;
    trend.push({ key: `${year}-${month}`, label: new Date(Date.UTC(year, month)).toLocaleString('en-IN', { month: 'short', timeZone: 'UTC' }), spend: 0, weight: 0, trips: 0 });
  }
  const months = new Map(trend.map(row => [row.key, row]));
  const suppliers = new Map<string, { name: string; rvp: number }>();
  let billing = 0, party = 0, rvp = 0;
  for (const p of purchases) {
    const date = monthOf(p.stockIn.arrivalDate || p.createdAt);
    const row = months.get(`${date.year}-${date.month}`);
    if (row) { row.spend += Number(p.verification?.totalAmount || 0); row.weight += p.netWeightKg; row.trips++; }
    billing += p.stockIn.billingWeightKg ?? 0;
    party += p.stockIn.partyKataKg ?? 0;
    rvp += p.netWeightKg;
    const name = p.stockIn.purchaseOrder.party.name;
    const supplier = suppliers.get(name) ?? { name, rvp: 0 };
    supplier.rvp += p.netWeightKg;
    suppliers.set(name, supplier);
  }
  const saleCounts: Record<string, number> = {};
  const buyers = new Map<string, { name: string; count: number; ordered: number; dispatched: number }>();
  for (const sale of sales) {
    // Match the sale register's normalization of closed partial orders.
    const status = sale.closedAt && ['PENDING', 'PARTIAL'].includes(sale.status)
      ? (sale.dispatches.length && sale.dispatches.every(d => d.status === 'DELIVERED') ? 'DELIVERED' : 'DISPATCHED')
      : sale.status;
    saleCounts[status] = (saleCounts[status] ?? 0) + 1;
    const name = sale.buyer.name;
    const buyer = buyers.get(name) ?? { name, count: 0, ordered: 0, dispatched: 0 };
    buyer.count++;
    buyer.ordered += sale.tonnageKg;
    buyer.dispatched += sale.dispatches.reduce((sum, d) => sum + d.weightKg, 0);
    buyers.set(name, buyer);
  }
  return {
    trend,
    poCounts: Object.fromEntries(purchaseCounts.map(row => [row.status, row._count._all])),
    saleCounts,
    topSuppliers: [...suppliers.values()].sort((a, b) => b.rvp - a.rvp).slice(0, 6)
      .map(s => ({ name: s.name.length > 16 ? s.name.slice(0, 15) + '…' : s.name, value: Math.round(s.rvp) })),
    topBuyersList: [...buyers.values()].sort((a, b) => b.dispatched - a.dispatched).slice(0, 10)
      .map(b => ({ ...b, remaining: Math.max(0, b.ordered - b.dispatched), fulfilPct: b.ordered > 0 ? b.dispatched / b.ordered * 100 : 0 })),
    reconciliation: { billing: Math.round(billing), party: Math.round(party), rvp: Math.round(rvp) },
  };
}
