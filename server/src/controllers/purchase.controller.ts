import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { createPurchaseSchema } from '../schemas/purchase.schema.js';
import { calcHamali, calcKataFee, companyHamaliShare, calcBags, calcBagCutting, DEFAULT_HAMALI_RATE } from '../lib/calc.js';

/**
 * Bag-cutting is only charged when seed lands directly at the process bunker.
 * Storage stock (Rampalli/Murgan/Multi) gets it later on the Stock Transfer.
 */
function bagCutting(location: string, netWeightKg: number, place: 'A' | 'B' | null | undefined) {
  if (location !== 'At process' || !place) {
    return { bunkerPlace: null as 'A' | 'B' | null, bagCount: 0, bagCuttingCharge: 0 };
  }
  return {
    bunkerPlace: place,
    bagCount: calcBags(netWeightKg),
    bagCuttingCharge: calcBagCutting(netWeightKg, place),
  };
}
import { InventoryService } from '../services/inventory.service.js';

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

  const { getCompanyProfileRow } = await import('./settings.controller.js');
  const companyProfile = await getCompanyProfileRow();
  const { isVehicleExempt } = await import('../lib/calc.js');
  const isCompanyVehicle = isVehicleExempt(stockIn.lorryNumber, companyProfile.companyVehicles);

  const hamaliRate = data.hamaliRate ?? DEFAULT_HAMALI_RATE;
  const hamaliCharge = calcHamali(netWeightKg, hamaliRate, isCompanyVehicle);
  const kataFee = calcKataFee(netWeightKg, isCompanyVehicle);
  const bag = bagCutting(stockIn.loadingLocation, netWeightKg, data.bunkerPlace);
  // Inward freight is captured at Stock In (BASE-priced POs only) and carried
  // through here; DELIVERY-priced POs already include freight in the price.
  const freightCharge = stockIn.purchaseOrder.priceType === 'BASE' ? Number(stockIn.freightCharge) : 0;

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
    const createdPurchase = await tx.purchase.create({
      data: {
        stockInId: data.stockInId,
        netWeightKg,
        hamaliRate,
        hamaliCharge,
        kataFee,
        bunkerPlace: bag.bunkerPlace,
        bagCount: bag.bagCount,
        bagCuttingCharge: bag.bagCuttingCharge,
        freightCharge,
      },
      include: purchaseInclude,
    });

    // 3. Update SiloInventory (Raw Black Seed MAP) immediately on recording
    // purchase. Inventory value carries the company's half of the hamali, the
    // bag-cutting charge, and the inward freight (all capitalised into the seed).
    const pricePerKg = Number(stockIn.purchaseOrder.pricePerKg);
    const originalCost =
      netWeightKg * pricePerKg + companyHamaliShare(Number(hamaliCharge)) + bag.bagCuttingCharge + freightCharge;
    await InventoryService.updateBlackSeedInventory(
      tx,
      stockIn.loadingLocation,
      netWeightKg,
      originalCost
    );

    return createdPurchase;
  });

  res.status(201).json(purchase);
}

export async function updatePurchase(req: Request, res: Response) {
  const data = createPurchaseSchema.parse(req.body);
  const purchase = await prisma.purchase.findUnique({
    where: { id: req.params.id },
    include: { stockIn: { include: { purchaseOrder: true } } },
  });
  if (!purchase) throw new HttpError(404, 'Purchase not found');

  if (data.rvpSecondWeightKg >= purchase.stockIn.rvpFirstWeightKg) {
    throw new HttpError(400, 'RVP second weight must be less than first weight');
  }
  const netWeightKg = purchase.stockIn.rvpFirstWeightKg - data.rvpSecondWeightKg;

  const { getCompanyProfileRow } = await import('./settings.controller.js');
  const companyProfile = await getCompanyProfileRow();
  const { isVehicleExempt } = await import('../lib/calc.js');
  const isCompanyVehicle = isVehicleExempt(purchase.stockIn.lorryNumber, companyProfile.companyVehicles);

  const hamaliRate = data.hamaliRate ?? DEFAULT_HAMALI_RATE;
  const hamaliCharge = calcHamali(netWeightKg, hamaliRate, isCompanyVehicle);
  const kataFee = calcKataFee(netWeightKg, isCompanyVehicle);
  // Re-pick the place: caller may change it, otherwise keep the existing one.
  const place = data.bunkerPlace !== undefined ? data.bunkerPlace : (purchase.bunkerPlace as 'A' | 'B' | null);
  const bag = bagCutting(purchase.stockIn.loadingLocation, netWeightKg, place);
  // Inward freight is sourced from the StockIn record (captured at arrival).
  const freightCharge = purchase.stockIn.purchaseOrder.priceType === 'BASE' ? Number(purchase.stockIn.freightCharge) : 0;

  const updated = await prisma.$transaction(async (tx) => {
    // 1. Revert the old inventory weight and cost
    const pricePerKg = Number(purchase.stockIn.purchaseOrder.pricePerKg);
    const oldCost =
      purchase.netWeightKg * pricePerKg +
      companyHamaliShare(Number(purchase.hamaliCharge)) +
      Number(purchase.bagCuttingCharge) +
      Number(purchase.freightCharge);
    await InventoryService.updateBlackSeedInventory(
      tx,
      purchase.stockIn.loadingLocation,
      -purchase.netWeightKg,
      -oldCost
    );

    // 2. Update StockIn
    await tx.stockIn.update({
      where: { id: purchase.stockInId },
      data: {
        rvpSecondWeightKg: data.rvpSecondWeightKg,
        rvpKataKg: netWeightKg,
      },
    });

    // 3. Update Purchase
    const updatedPurchase = await tx.purchase.update({
      where: { id: req.params.id },
      data: {
        netWeightKg,
        hamaliRate,
        hamaliCharge,
        kataFee,
        bunkerPlace: bag.bunkerPlace,
        bagCount: bag.bagCount,
        bagCuttingCharge: bag.bagCuttingCharge,
        freightCharge,
      },
      include: purchaseInclude,
    });

    // 4. Add the new inventory weight and cost
    const newCost =
      netWeightKg * pricePerKg + companyHamaliShare(Number(hamaliCharge)) + bag.bagCuttingCharge + freightCharge;
    await InventoryService.updateBlackSeedInventory(
      tx,
      purchase.stockIn.loadingLocation,
      netWeightKg,
      newCost
    );

    return updatedPurchase;
  });

  res.json(updated);
}

export async function deletePurchase(req: Request, res: Response) {
  const purchase = await prisma.purchase.findUnique({
    where: { id: req.params.id },
    include: {
      verification: true,
      stockIn: { include: { purchaseOrder: true } },
    },
  });
  if (!purchase) throw new HttpError(404, 'Purchase not found');

  await prisma.$transaction(async (tx) => {
    // 1. Revert inventory (subtract from SiloInventory)
    const pricePerKg = Number(purchase.stockIn.purchaseOrder.pricePerKg);
    const ourHamali = companyHamaliShare(Number(purchase.hamaliCharge));
    const bagCut = Number(purchase.bagCuttingCharge);
    const freight = Number(purchase.freightCharge);

    if (purchase.verification) {
      const verifiedCost = Number(purchase.verification.totalAmount) + ourHamali + bagCut + freight;
      await InventoryService.updateBlackSeedInventory(
        tx,
        purchase.stockIn.loadingLocation,
        -purchase.verification.finalWeightKg,
        -verifiedCost
      );
      await tx.weightVerification.delete({ where: { purchaseId: req.params.id } });
    } else {
      const originalCost = purchase.netWeightKg * pricePerKg + ourHamali + bagCut + freight;
      await InventoryService.updateBlackSeedInventory(
        tx,
        purchase.stockIn.loadingLocation,
        -purchase.netWeightKg,
        -originalCost
      );
    }

    // 2. Delete Purchase
    await tx.purchase.delete({ where: { id: req.params.id } });

    // 3. Reset weights in StockIn
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
