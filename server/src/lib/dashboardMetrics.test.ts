import { describe, expect, it } from 'vitest';
import { buildDashboardMetrics } from './dashboardMetrics.js';

describe('dashboard chart summaries', () => {
  it('keeps full-history totals, IST months and closed-order fulfilment', () => {
    const purchase = { createdAt: new Date('2026-03-31T20:00:00Z'), netWeightKg: 950,
      verification: { totalAmount: '1500.50' }, stockIn: { arrivalDate: new Date('2026-03-31T20:00:00Z'),
      billingWeightKg: 1000, partyKataKg: 980, purchaseOrder: { party: { name: 'Supplier' } } } };
    const sale = { status: 'PARTIAL', closedAt: new Date(), tonnageKg: 1000,
      buyer: { name: 'Buyer' }, dispatches: [{ weightKg: 900, status: 'DELIVERED' }] };
    const result = buildDashboardMetrics([purchase, purchase], [sale, { ...sale, closedAt: null }],
      [{ status: 'PENDING', _count: { _all: 7 } }], new Date('2026-04-02T00:00:00Z'));
    expect(result.trend.map(m => m.spend)).toEqual([0, 3001]);
    expect(result.trend[1].trips).toBe(2);
    expect(result.poCounts.PENDING).toBe(7);
    expect(result.saleCounts).toEqual({ DELIVERED: 1, PARTIAL: 1 });
    expect(result.reconciliation).toEqual({ billing: 2000, party: 1960, rvp: 1900 });
    expect(result.topBuyersList[0]).toMatchObject({ ordered: 2000, dispatched: 1800, remaining: 200, fulfilPct: 90 });
    expect(result.topSuppliers[0]).toEqual({ name: 'Supplier', value: 1900 });
  });
  it('returns empty collections and zero totals without transactions', () => {
    const result = buildDashboardMetrics([], [], [], new Date('2026-03-01'));
    expect(result.topBuyersList).toEqual([]);
    expect(result.reconciliation).toEqual({ billing: 0, party: 0, rvp: 0 });
    expect(result.trend).toHaveLength(1);
  });
});
