import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';

export async function dashboardSummary(_req: Request, res: Response) {
  const [
    pendingPOs,
    arrivedPOs,
    pendingSales,
    unprocessedVerified,
    pappuProducedAgg,
    pappuDispatchedAgg,
    payableAgg,
  ] = await Promise.all([
    prisma.purchaseOrder.count({ where: { status: 'PENDING' } }),
    prisma.purchaseOrder.count({ where: { status: 'ARRIVED' } }),
    prisma.saleOrder.count({ where: { status: 'PENDING' } }),
    // Verified black seed not yet processed (= stock on hand, in kg).
    prisma.purchase.findMany({
      where: { verification: { isNot: null }, processing: { is: null } },
      select: { verification: { select: { finalWeightKg: true } } },
    }),
    prisma.processing.aggregate({ _sum: { pappuWeightKg: true } }),
    prisma.saleDispatch.aggregate({ _sum: { dispatchWeightKg: true } }),
    // Total verified payable to suppliers (no Payment model yet — open question #6).
    prisma.weightVerification.aggregate({ _sum: { totalAmount: true } }),
  ]);

  const blackStockOnHandKg = unprocessedVerified.reduce(
    (sum, p) => sum + (p.verification?.finalWeightKg ?? 0),
    0
  );
  const pappuProducedKg = pappuProducedAgg._sum.pappuWeightKg ?? 0;
  const pappuDispatchedKg = pappuDispatchedAgg._sum.dispatchWeightKg ?? 0;
  const pappuInventoryKg = pappuProducedKg - pappuDispatchedKg;
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
