import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { createStockTransferSchema } from '../schemas/purchase.schema.js';
import { transferHamali, TRANSFER_TRANSPORT, companyHamaliShare } from '../lib/calc.js';
import { InventoryService } from '../services/inventory.service.js';
import { LedgerService } from '../services/ledger.service.js';

/**
 * Value the next `weightKg` of black seed drawn from a storage location by PRICE
 * BAND (highest price first, oldest lot within a band) - the same top-to-bottom
 * depletion order the Black Seed Stock / Order Planner pages use - instead of the
 * silo's blended MAP average. Each lot is valued at its LANDED cost EXCLUDING GST:
 *   netKg × price + company hamali share + inward freight.
 * Prior transfers out of this location are drawn down first, so we only value the
 * seed still physically sitting in storage.
 */
async function drawStorageBandValue(
  tx: Prisma.TransactionClient,
  fromLocation: string,
  weightKg: number
): Promise<number> {
  const purchases = await tx.purchase.findMany({
    where: { stockIn: { loadingLocation: fromLocation } },
    include: { verification: true, stockIn: { include: { purchaseOrder: true } } },
  });

  type Lot = { price: number; netKg: number; perKg: number; date: Date };
  const lots: Lot[] = [];
  for (const p of purchases) {
    const netKg = p.netWeightKg;
    if (netKg <= 0) continue;
    const price = p.verification ? Number(p.verification.pricePerKg) : Number(p.stockIn.purchaseOrder.pricePerKg);
    const ourHamali = companyHamaliShare(Number(p.hamaliCharge));
    const freight = Number(p.freightCharge);
    
    // The transferred seed value must carry its share of inward company hamali and inward freight,
    // otherwise the crediting value falls short and orphaned balances are left at the source location.
    const landedPerKg = price + (ourHamali / netKg) + (freight / netKg);
    lots.push({ price: landedPerKg, netKg, perKg: landedPerKg, date: p.stockIn.arrivalDate });
  }

  // Highest price band first; oldest lot first within the same band.
  lots.sort((a, z) => (z.price - a.price) || (a.date.getTime() - z.date.getTime()));

  // Draw down PRIOR transfers out of this location first (same band order). The
  // transfer being recorded isn't persisted yet, so every existing transfer counts.
  const priorAgg = await tx.stockTransfer.aggregate({
    where: { fromLocation },
    _sum: { weightKg: true },
  });
  let priorKg = priorAgg._sum.weightKg ?? 0;

  const remaining = lots.map((l) => l.netKg);
  for (let i = 0; i < lots.length && priorKg > 0; i++) {
    const take = Math.min(priorKg, remaining[i]);
    remaining[i] -= take;
    priorKg -= take;
  }

  // Value this transfer's weight from what's left, at each lot's band price.
  let needKg = weightKg;
  let value = 0;
  for (let i = 0; i < lots.length && needKg > 0; i++) {
    const take = Math.min(needKg, remaining[i]);
    if (take <= 0) continue;
    value += take * lots[i].perKg;
    needKg -= take;
  }

  return Math.round(value * 100) / 100;
}

export async function listStockTransfers(_req: Request, res: Response) {
  const transfers = await prisma.stockTransfer.findMany({
    orderBy: { transferDate: 'desc' },
  });
  res.json(transfers);
}

/**
 * Record a black-seed transfer from a storage location to the process. The seed is
 * valued by the specific PRICE BAND it is drawn from (top-to-bottom, highest band
 * first - see {@link drawStorageBandValue}), NOT the silo's blended MAP average.
 * A fixed hamali (₹270/t load+unload, all crew - the storage-unload leg is no
 * longer charged) and a fixed ₹500 transport are capitalised into the seed's value
 * at the process silo. Company-vehicle exemption does not apply to transfers
 * (only to arrivals).
 */
export async function createStockTransfer(req: Request, res: Response) {
  const data = createStockTransferSchema.parse(req.body);

  // The source silo must actually hold enough seed to move.
  const source = await prisma.siloInventory.findFirst({
    where: { itemType: 'BLACK_SEED', location: data.fromLocation },
  });
  if (!source || source.weightKg < data.weightKg) {
    throw new HttpError(
      400,
      `Not enough black seed at ${data.fromLocation} (have ${source?.weightKg ?? 0} kg, need ${data.weightKg} kg)`
    );
  }

  const { getHamaliRate } = await import('./settings.controller.js');
  const hamali = transferHamali(data.weightKg, await getHamaliRate('TRANSFER_FROM_STORAGE'));
  const transportCharge = TRANSFER_TRANSPORT;

  const legCharge = hamali.charge;
  const legCrew = hamali.crew;
  const legMargin = hamali.margin;

  // The transfer hamali (₹270/t) + fixed ₹500 transport travel WITH the seed:
  // they are capitalised into the seed's value at the destination, so the value
  // arriving at RVP = seed value moved + these costs. No bank-loan interest is
  // charged on transfers.
  const addedCost = legCharge + transportCharge;

  const transfer = await prisma.$transaction(async (tx) => {
    // Value the seed by the specific PRICE BAND being depleted (top-to-bottom),
    // NOT the source silo's blended MAP average.
    const seedCostMoved = await drawStorageBandValue(tx, data.fromLocation, data.weightKg);

    // Physically move the seed: remove the weight + its band value from the source
    // silo, and add the weight + band value + the capitalised transfer costs to the
    // destination silo.
    await InventoryService.updateBlackSeedInventory(tx, data.fromLocation, -data.weightKg, -seedCostMoved);
    await InventoryService.updateBlackSeedInventory(tx, data.toLocation, data.weightKg, seedCostMoved + addedCost);

    // Value arriving at RVP = seed value moved + the capitalised transfer costs.
    const movedValue = Math.round((seedCostMoved + addedCost) * 100) / 100;

    const created = await tx.stockTransfer.create({
      data: {
        fromLocation: data.fromLocation,
        toLocation: data.toLocation,
        weightKg: data.weightKg,
        lorryNumber: data.lorryNumber ?? null,
        transportCharge,
        loadingHamali: hamali.unloadCharge, // storage unload leg - no longer charged, always 0
        unloadingHamali: hamali.handlingCharge, // load + unload combined
        hamaliMargin: legMargin,
        interestCharge: 0,
        interestDays: 0,
        interestRatePct: 0,
        seedCostMoved,
        movedValue,
        transferDate: data.transferDate,
      },
    });

    await LedgerService.postStockTransfer(tx, created.id, {
      fromLocation: data.fromLocation,
      toLocation: data.toLocation,
      weightKg: data.weightKg,
      seedCostMoved,
      legCharge,
      legCrew,
      legMargin,
      transportCharge,
    });

    return created;
  });

  res.status(201).json(transfer);
}

/**
 * Reverse a transfer: move the seed back to the source silo. Uses the
 * destination's current MAP, so the source is restored to roughly its prior
 * value (the original journal entry is left in place for audit).
 */
export async function deleteStockTransfer(req: Request, res: Response) {
  const transfer = await prisma.stockTransfer.findUnique({ where: { id: req.params.id } });
  if (!transfer) throw new HttpError(404, 'Stock transfer not found');

  const dest = await prisma.siloInventory.findFirst({
    where: { itemType: 'BLACK_SEED', location: transfer.toLocation },
  });
  if (!dest || dest.weightKg < transfer.weightKg) {
    throw new HttpError(
      400,
      `Cannot reverse: ${transfer.toLocation} no longer holds ${transfer.weightKg} kg (seed already consumed/sold)`
    );
  }

  await prisma.$transaction(async (tx) => {
    await InventoryService.transferBlackSeed(
      tx,
      transfer.toLocation,
      transfer.fromLocation,
      transfer.weightKg,
      0
    );
    await tx.stockTransfer.delete({ where: { id: transfer.id } });
  });

  res.json({ message: 'Stock transfer reversed' });
}
