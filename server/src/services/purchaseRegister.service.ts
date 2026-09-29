import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { withCache } from '../lib/cache.js';
import { purchaseRegisterSchema } from '../schemas/purchase.schema.js';

export async function getPurchaseRegister(query: unknown) {
  const { skip, take, all, priceType, party } = purchaseRegisterSchema.parse(query);
  const where: Prisma.PurchaseWhereInput = {
    stockIn: { purchaseOrder: {
      ...(priceType !== 'ALL' ? { priceType } : {}),
      ...(party !== 'ALL' ? { party: { name: party } } : {}),
    } },
  };
  const [rows, total, summary] = await Promise.all([
    prisma.purchase.findMany({
      where, skip: all === 'true' ? undefined : skip, take: all === 'true' ? undefined : take,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { verification: true, stockIn: { include: { purchaseOrder: { include: { party: true } }, weighbridgeTicket: true } } },
    }),
    prisma.purchase.count({ where }),
    // Full-register cards and filter choices must not shrink to the current page.
    // API mutation middleware clears this cache after successful writes.
    withCache('purchase_register_summary', 60, async () => {
      const [totals, parties] = await Promise.all([
        prisma.purchase.aggregate({ _count: { _all: true }, _sum: { netWeightKg: true, hamaliCharge: true, kataFee: true } }),
        prisma.party.findMany({
          where: { purchaseOrders: { some: { stockIns: { some: { purchase: { isNot: null } } } } } },
          select: { name: true }, orderBy: { name: 'asc' },
        }),
      ]);
      return { count: totals._count._all, totalNet: Number(totals._sum.netWeightKg ?? 0),
        totalHamali: Number(totals._sum.hamaliCharge ?? 0), totalKata: Number(totals._sum.kataFee ?? 0),
        parties: [...new Set(parties.map(p => p.name))] };
    }),
  ]);
  return { rows, total, summary };
}
