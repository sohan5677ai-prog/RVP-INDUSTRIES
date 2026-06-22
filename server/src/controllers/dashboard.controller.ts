import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';

export async function dashboardSummary(_req: Request, res: Response) {
  const PAPPU_OUTTURN = 0.6;
  const [
    pendingPOs,
    arrivedPOs,
    pendingSales,
    verifiedSeed,
    pappuDispatchedAgg,
    payableAgg,
  ] = await Promise.all([
    prisma.purchaseOrder.count({ where: { status: 'PENDING' } }),
    prisma.purchaseOrder.count({ where: { status: 'ARRIVED' } }),
    prisma.saleOrder.count({ where: { status: 'PENDING' } }),
    // All verified black seed received (one pool — milling does not deplete it).
    prisma.weightVerification.aggregate({ _sum: { finalWeightKg: true } }),
    // Pappu sold = dispatched/reached Pappu sale orders (RVP kata weight).
    prisma.saleOrder.aggregate({
      _sum: { tonnageKg: true },
      where: { product: 'PAPPU', status: { in: ['DISPATCHED', 'REACHED'] } },
    }),
    // Total verified payable to suppliers (no Payment model yet — open question #6).
    prisma.weightVerification.aggregate({ _sum: { totalAmount: true } }),
  ]);

  const receivedSeedKg = verifiedSeed._sum.finalWeightKg ?? 0;
  const pappuDispatchedKg = pappuDispatchedAgg._sum.tonnageKg ?? 0;
  // Black seed is depleted only when pappu is sold: each kg sold used 1/0.6 kg seed.
  const blackStockOnHandKg = Math.max(0, receivedSeedKg - pappuDispatchedKg / PAPPU_OUTTURN);
  // Pappu produced is the derived potential of all received seed (60% out-turn).
  const pappuProducedKg = Math.round(receivedSeedKg * PAPPU_OUTTURN);
  const pappuInventoryKg = Math.max(0, pappuProducedKg - pappuDispatchedKg);
  const supplierPayable = Number(payableAgg._sum.totalAmount ?? 0);

  res.json({
    pendingPOs,
    arrivedPOs,
    pendingSales,
    blackStockOnHandKg,
    pappuProducedKg,
    pappuDispatchedKg,
    pappuInventoryKg,
    supplierPayable,
  });
}
