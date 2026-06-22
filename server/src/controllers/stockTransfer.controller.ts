import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { createStockTransferSchema } from '../schemas/purchase.schema.js';
import { transferHamali, calcBags, calcBagCutting, TRANSFER_TRANSPORT, daysBetween, loanInterest } from '../lib/calc.js';
import { InventoryService } from '../services/inventory.service.js';
import { LedgerService } from '../services/ledger.service.js';
import { getEarliestOpenLoanDate, getCurrentLoanRate } from './loan.controller.js';

export async function listStockTransfers(_req: Request, res: Response) {
  const transfers = await prisma.stockTransfer.findMany({
    orderBy: { transferDate: 'desc' },
  });
  res.json(transfers);
}

/**
 * Record a black-seed transfer from a storage location to the process. Incurs a
 * fixed hamali (₹80/t storage unload split ₹70 crew + ₹10 profit, plus ₹270/t
 * load+unload all crew), a fixed ₹500 transport, and bag-cutting at the
 * destination bunker — all 100% company-borne and capitalised into the seed's
 * value at the process silo. Company-vehicle exemption does not apply to
 * transfers (only to arrivals).
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

  const hamali = transferHamali(data.weightKg);
  const bagCount = data.bunkerPlace ? calcBags(data.weightKg) : 0;
  const bagCuttingCharge = data.bunkerPlace ? calcBagCutting(data.weightKg, data.bunkerPlace) : 0;
  const transportCharge = TRANSFER_TRANSPORT;

  const legCharge = hamali.charge;
  const legCrew = hamali.crew;
  const legMargin = hamali.margin;
  const addedCost = legCharge + transportCharge + bagCuttingCharge;

  // Bank-loan carrying interest: charged on the seed value moved, for the days
  // it sat in storage (from the earliest open loan's drawdown to this transfer),
  // at the current annual rate. Zero when no loan is open.
  const earliestOpenLoanDate = await getEarliestOpenLoanDate();
  const interestRatePct = await getCurrentLoanRate();
  const interestDays = earliestOpenLoanDate
    ? daysBetween(earliestOpenLoanDate, data.transferDate)
    : 0;

  const transfer = await prisma.$transaction(async (tx) => {
    const seedCostMoved = await InventoryService.transferBlackSeed(
      tx,
      data.fromLocation,
      data.toLocation,
      data.weightKg,
      addedCost
    );

    // Interest is computed on the actual seed value drawn from the source silo,
    // then added to the destination silo's value (0 extra weight, more value).
    const interestCharge = interestDays > 0
      ? loanInterest(seedCostMoved, interestRatePct, interestDays)
      : 0;
    if (interestCharge > 0) {
      await InventoryService.updateBlackSeedInventory(tx, data.toLocation, 0, interestCharge);
    }

    const movedValue = Math.round((seedCostMoved + addedCost + interestCharge) * 100) / 100;

    const created = await tx.stockTransfer.create({
      data: {
        fromLocation: data.fromLocation,
        toLocation: data.toLocation,
        weightKg: data.weightKg,
        lorryNumber: data.lorryNumber ?? null,
        transportCharge,
        loadingHamali: hamali.unloadCharge, // storage unload leg (₹80/t)
        unloadingHamali: hamali.handlingCharge, // load + unload combined (₹270/t)
        bunkerPlace: data.bunkerPlace ?? null,
        bagCount,
        bagCuttingCharge,
        hamaliMargin: legMargin,
        interestCharge,
        interestDays,
        interestRatePct,
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
      bagCuttingCharge,
      interestCharge,
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
