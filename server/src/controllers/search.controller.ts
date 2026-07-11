import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';

export async function globalSearch(req: Request, res: Response) {
  const q = String(req.query.q || '').trim();
  const type = String(req.query.type || '');

  if (!q) {
    return res.json([]);
  }

  if (type === 'party') {
    const parties = await prisma.party.findMany({
      where: {
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { phone: { contains: q, mode: 'insensitive' } },
          { gstin: { contains: q, mode: 'insensitive' } },
        ],
      },
      take: 6,
    });
    return res.json(parties);
  }

  if (type === 'po') {
    const pos = await prisma.purchaseOrder.findMany({
      where: {
        OR: [
          { poNumber: { contains: q, mode: 'insensitive' } },
          { party: { name: { contains: q, mode: 'insensitive' } } },
        ],
      },
      include: { party: true },
      take: 6,
    });
    return res.json(pos);
  }

  if (type === 'sale') {
    const sales = await prisma.saleOrder.findMany({
      where: {
        OR: [
          { buyer: { name: { contains: q, mode: 'insensitive' } } },
          { dispatches: { some: { invoiceNumber: { contains: q, mode: 'insensitive' } } } },
        ],
      },
      include: { buyer: true, dispatches: true },
      take: 6,
    });
    return res.json(sales);
  }

  if (type === 'stock') {
    const { computeUnifiedStockEngine } = await import('../services/stockEngine.js');
    const { bands } = await computeUnifiedStockEngine('MOST_EXPENSIVE_FIRST');
    const allLots = bands.flatMap(b => b.lots);
    
    const filtered = allLots.filter((r) =>
      r.partyName.toLowerCase().includes(q.toLowerCase()) ||
      (r.lorryNumber ?? '').toLowerCase().includes(q.toLowerCase()) ||
      (r.poNumber ?? '').toLowerCase().includes(q.toLowerCase())
    ).slice(0, 6);

    return res.json(
      filtered.map((r) => ({
        purchaseId: r.purchaseId,
        date: r.date.toISOString(),
        invoiceNumber: '',
        partyName: r.partyName,
        poNumber: r.poNumber,
        lorryNumber: r.lorryNumber,
        rvpNetWeightKg: r.receivedKg,
        location: 'RVP',
        pricePerKg: r.pricePerKg,
        value: r.receivedKg * r.pricePerKg,
        verified: true,
      }))
    );
  }

  return res.json([]);
}
