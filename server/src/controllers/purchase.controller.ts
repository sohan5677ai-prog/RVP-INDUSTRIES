import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { createPurchaseSchema } from '../schemas/purchase.schema.js';
import { calcHamali, calcKataFee, DEFAULT_HAMALI_RATE } from '../lib/calc.js';

const purchaseInclude = {
  verification: true,
  stockIn: { include: { purchaseOrder: { include: { party: true } } } },
} as const;

export async function listPurchases(_req: Request, res: Response) {
  const purchases = await prisma.purchase.findMany({
    orderBy: { createdAt: 'desc' },
    include: purchaseInclude,
  });
  res.json(purchases);
}

export async function getPurchase(req: Request, res: Response) {
  const purchase = await prisma.purchase.findUnique({
    where: { id: req.params.id },
    include: purchaseInclude,
  });
  if (!purchase) throw new HttpError(404, 'Purchase not found');
  res.json(purchase);
}

/**
 * Record a Purchase from a StockIn: stores the net weight (= RVP Kata) and the
 * hamali charge. Weight cross-verification is now a separate step on the
 * Verification page — it is NOT run here.
 */
export async function createPurchase(req: Request, res: Response) {
  const data = createPurchaseSchema.parse(req.body);

  const stockIn = await prisma.stockIn.findUnique({
    where: { id: data.stockInId },
    include: { purchase: true, purchaseOrder: true },
  });
  if (!stockIn) throw new HttpError(400, 'Stock-in not found');
  if (stockIn.purchase) throw new HttpError(409, 'Purchase already recorded for this stock-in');

  if (data.rvpSecondWeightKg >= stockIn.rvpFirstWeightKg) {
    throw new HttpError(400, 'RVP second weight must be less than first weight');
  }
  const netWeightKg = stockIn.rvpFirstWeightKg - data.rvpSecondWeightKg;

  const hamaliRate = data.hamaliRate ?? DEFAULT_HAMALI_RATE;
  const hamaliCharge = calcHamali(netWeightKg, hamaliRate);
  const kataFee = calcKataFee(netWeightKg);

  const distance = stockIn.carterDistanceKm;
  let carterRate = 400;
  if (distance > 150) {
    carterRate = 800;
  } else if (distance >= 50) {
    carterRate = 600;
  }
  const carterCharge = (netWeightKg / 1000) * carterRate;

  const purchase = await prisma.$transaction(async (tx) => {
    // 1. Update StockIn with rvpSecondWeightKg and rvpKataKg
    await tx.stockIn.update({
      where: { id: data.stockInId },
      data: {
        rvpSecondWeightKg: data.rvpSecondWeightKg,
        rvpKataKg: netWeightKg,
      },
    });

    // 2. Create Purchase
    return await tx.purchase.create({
      data: {
        stockInId: data.stockInId,
        netWeightKg,
        hamaliRate,
        hamaliCharge,
        kataFee,
        carterCharge,
      },
      include: purchaseInclude,
    });
  });

  res.status(201).json(purchase);
}

export async function updatePurchase(req: Request, res: Response) {
  const data = createPurchaseSchema.parse(req.body);
  const purchase = await prisma.purchase.findUnique({
    where: { id: req.params.id },
    include: { stockIn: true },
  });
  if (!purchase) throw new HttpError(404, 'Purchase not found');

  if (data.rvpSecondWeightKg >= purchase.stockIn.rvpFirstWeightKg) {
    throw new HttpError(400, 'RVP second weight must be less than first weight');
  }
  const netWeightKg = purchase.stockIn.rvpFirstWeightKg - data.rvpSecondWeightKg;

  const hamaliRate = data.hamaliRate ?? DEFAULT_HAMALI_RATE;
  const hamaliCharge = calcHamali(netWeightKg, hamaliRate);
  const kataFee = calcKataFee(netWeightKg);

  const distance = purchase.stockIn.carterDistanceKm;
  let carterRate = 400;
  if (distance > 150) {
    carterRate = 800;
  } else if (distance >= 50) {
    carterRate = 600;
  }
  const carterCharge = (netWeightKg / 1000) * carterRate;

  const updated = await prisma.$transaction(async (tx) => {
    // 1. Update StockIn
    await tx.stockIn.update({
      where: { id: purchase.stockInId },
      data: {
        rvpSecondWeightKg: data.rvpSecondWeightKg,
        rvpKataKg: netWeightKg,
      },
    });

    // 2. Update Purchase
    return await tx.purchase.update({
      where: { id: req.params.id },
      data: {
        netWeightKg,
        hamaliRate,
        hamaliCharge,
        kataFee,
        carterCharge,
      },
      include: purchaseInclude,
    });
  });

  res.json(updated);
}

export async function deletePurchase(req: Request, res: Response) {
  const purchase = await prisma.purchase.findUnique({
    where: { id: req.params.id },
    include: { verification: true },
  });
  if (!purchase) throw new HttpError(404, 'Purchase not found');

  await prisma.$transaction(async (tx) => {
    if (purchase.verification) {
      await tx.weightVerification.delete({ where: { purchaseId: req.params.id } });
    }
    await tx.purchase.delete({ where: { id: req.params.id } });
    // Reset weights in StockIn
    await tx.stockIn.update({
      where: { id: purchase.stockInId },
      data: {
        rvpSecondWeightKg: 0,
        rvpKataKg: 0,
      },
    });
  });

  res.json({ message: 'Purchase deleted' });
}
