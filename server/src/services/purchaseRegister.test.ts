import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ purchase: { findMany: vi.fn(), count: vi.fn(), aggregate: vi.fn() }, party: { findMany: vi.fn() } }));
vi.mock('../lib/prisma.js', () => ({ prisma: db }));
import { getPurchaseRegister } from './purchaseRegister.service.js';
import { clearCache } from '../lib/cache.js';

beforeEach(() => {
  clearCache(); vi.resetAllMocks();
  db.purchase.findMany.mockResolvedValue([{ id: 'page-row' }]);
  db.purchase.count.mockResolvedValue(75);
  db.purchase.aggregate.mockResolvedValue({ _count: { _all: 500 }, _sum: { netWeightKg: 10000, hamaliCharge: '2000.50', kataFee: '500' } });
  db.party.findMany.mockResolvedValue([{ name: 'Supplier A' }, { name: 'Supplier B' }]);
});
describe('purchase register', () => {
  it('paginates and filters rows without reducing full-register totals', async () => {
    const result = await getPurchaseRegister({ skip: '50', take: '25', priceType: 'BASE', party: 'Supplier A' });
    expect(db.purchase.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 50, take: 25,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      where: { stockIn: { purchaseOrder: { priceType: 'BASE', party: { name: 'Supplier A' } } } } }));
    expect(result.total).toBe(75);
    expect(result.summary).toMatchObject({ count: 500, totalNet: 10000, totalHamali: 2000.5, totalKata: 500 });
    expect(result.rows).toHaveLength(1);
    expect(db.purchase.aggregate.mock.calls[0][0]).not.toHaveProperty('where');
  });
  it('exports every matching row without a page limit', async () => {
    await getPurchaseRegister({ all: 'true', party: 'Supplier B' });
    expect(db.purchase.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: undefined, take: undefined,
      where: { stockIn: { purchaseOrder: { party: { name: 'Supplier B' } } } } }));
  });
  it.each([{ take: '201' }, { skip: '-1' }, { take: 'bad' }, { priceType: 'unknown' }])('rejects invalid pagination before querying: %j', async query => {
    await expect(getPurchaseRegister(query)).rejects.toThrow();
    expect(db.purchase.findMany).not.toHaveBeenCalled();
  });
  it('shares summary work across pages, and refreshes after invalidation', async () => {
    await getPurchaseRegister({});
    await getPurchaseRegister({ skip: '50' });
    expect(db.purchase.aggregate).toHaveBeenCalledTimes(1);
    clearCache();
    await getPurchaseRegister({});
    expect(db.purchase.aggregate).toHaveBeenCalledTimes(2);
  });
});
