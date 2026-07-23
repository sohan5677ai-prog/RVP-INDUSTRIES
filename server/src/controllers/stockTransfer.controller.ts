import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { createStockTransferSchema } from '../schemas/purchase.schema.js';
import {
  transferHamali,
  transferTransportCharge,
  companyHamaliShare,
  transferLoanInterest,
  TRANSFER_INTEREST_MONTHLY_PCT,
  type DrawnSeedSlice,
} from '../lib/calc.js';
import { InventoryService } from '../services/inventory.service.js';
import { LedgerService } from '../services/ledger.service.js';
import { getEarliestOpenLoanDate } from './loan.controller.js';

// The transfer carrying-interest rate is a flat 0.85%/month; we persist it on the
// transfer row as an annual-equivalent so the client's existing "/12 → %/mo"
// display renders 0.85%/mo unchanged.
const TRANSFER_INTEREST_ANNUAL_PCT = TRANSFER_INTEREST_MONTHLY_PCT * 12;

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
  weightKg: number,
  loanAvailedDate?: Date | null
): Promise<{ value: number; slices: DrawnSeedSlice[] }> {
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
    const arrivalDate = loanAvailedDate ?? p.stockIn.arrivalDate;
    lots.push({ price: landedPerKg, netKg, perKg: landedPerKg, date: arrivalDate });
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

  // Value this transfer's weight from what's left, at each lot's band price, and
  // record each drawn slice (value + its storage arrival date) so carrying
  // interest can be accrued per lot by its actual dwell time.
  let needKg = weightKg;
  let value = 0;
  const slices: DrawnSeedSlice[] = [];
  for (let i = 0; i < lots.length && needKg > 0; i++) {
    const take = Math.min(needKg, remaining[i]);
    if (take <= 0) continue;
    const sliceValue = take * lots[i].perKg;
    value += sliceValue;
    slices.push({ value: sliceValue, arrivalDate: lots[i].date });
    needKg -= take;
  }

  return { value: Math.round(value * 100) / 100, slices };
}

export async function listStockTransfers(_req: Request, res: Response) {
  const transfers = await prisma.stockTransfer.findMany({
    orderBy: { transferDate: 'desc' },
  });
  res.json(transfers);
}

/**
 * Dry-run the transfer costing WITHOUT persisting anything, so the Record Transfer
 * dialog can show a live breakdown - seed value drawn from the price bands, the
 * capitalised hamali + transport, and the storage carrying interest with its
 * value-weighted dwell days - before the user commits. Runs the exact same band
 * draw + interest accrual the real save does, just against the live (read-only)
 * client instead of the write transaction.
 */
export async function previewStockTransfer(req: Request, res: Response) {
  const fromLocation = String(req.query.fromLocation ?? '');
  const weightKg = Number(req.query.weightKg);
  const transferDate = req.query.transferDate ? new Date(String(req.query.transferDate)) : new Date();

  if (!fromLocation || !Number.isFinite(weightKg) || weightKg <= 0) {
    throw new HttpError(400, 'fromLocation and a positive weightKg are required');
  }

  const { getHamaliRate } = await import('./settings.controller.js');
  const hamali = transferHamali(weightKg, await getHamaliRate('TRANSFER_FROM_STORAGE'));
  const transportCharge = transferTransportCharge(weightKg, fromLocation);

  const loanAvailedDate = await getEarliestOpenLoanDate(fromLocation);
  // `drawStorageBandValue` only reads, so the base client satisfies the tx type.
  const { value: seedCostMoved } = await drawStorageBandValue(prisma, fromLocation, weightKg, loanAvailedDate);
  // Carrying interest: fixed per-kg loan value × days since the loan was availed
  // (earliest open loan → transfer) × 0.85%/month. Independent of the drawn bands.
  const { interest: interestCharge, days: interestDays } = transferLoanInterest(
    weightKg,
    loanAvailedDate,
    transferDate
  );
  const interestRatePct = TRANSFER_INTEREST_ANNUAL_PCT;

  const addedCost = Math.round((hamali.charge + transportCharge + interestCharge) * 100) / 100;
  const movedValue = Math.round((seedCostMoved + addedCost) * 100) / 100;

  res.json({
    seedCostMoved,
    hamaliCharge: hamali.handlingCharge,
    transportCharge,
    interestCharge,
    interestDays,
    interestRatePct,
    movedValue,
  });
}

/**
 * Record a black-seed transfer from a storage location to the process. The seed is
 * valued by the specific PRICE BAND it is drawn from (top-to-bottom, highest band
 * first - see {@link drawStorageBandValue}), NOT the silo's blended MAP average.
 * A fixed hamali (₹270/t load+unload, all crew - the storage-unload leg is no
 * longer charged) and a per-tonne transport (₹250/t from PGR COLD / Murugan,
 * ₹100/t from KNM Multi, billed to KNM Transport) are capitalised into the seed's
 * value at the process silo. Company-vehicle exemption does not apply to transfers
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
  // Transfer transport is per-tonne, keyed to the source storage location, and
  // billed to KNM Transport (still capitalised into the seed at the process).
  const transportCharge = transferTransportCharge(data.weightKg, data.fromLocation);
  // Carrying interest is a flat 0.85%/month on a fixed per-kg loan value, charged
  // from the earliest open loan date to the transfer date (see transferLoanInterest).
  const interestRatePct = TRANSFER_INTEREST_ANNUAL_PCT;
  const loanAvailedDate = await getEarliestOpenLoanDate(data.fromLocation);

  const legCharge = hamali.charge;
  const legCrew = hamali.crew;
  const legMargin = hamali.margin;

  const transfer = await prisma.$transaction(async (tx) => {
    // Value the seed by the specific PRICE BAND being depleted (top-to-bottom),
    // NOT the source silo's blended MAP average. `slices` carries each drawn lot's
    // value + storage arrival date so interest can accrue by actual dwell time.
    const { value: seedCostMoved } = await drawStorageBandValue(tx, data.fromLocation, data.weightKg, loanAvailedDate);

    // Bank-loan carrying interest: fixed per-kg loan value × days since the loan
    // was availed × 0.85%/month, capitalised into the seed with the other costs.
    const { interest: interestCharge, days: interestDays } = transferLoanInterest(
      data.weightKg,
      loanAvailedDate,
      data.transferDate
    );

    // The transfer hamali (₹270/t) + per-tonne transport + carrying interest travel
    // WITH the seed: they are all capitalised into the seed's value at the
    // destination, so the value arriving at RVP = seed value moved + these costs.
    const addedCost = Math.round((legCharge + transportCharge + interestCharge) * 100) / 100;

    // Physically move the seed: remove the weight + its band value from the source
    // silo, and add the weight + band value + the capitalised transfer costs
    // (hamali + transport + interest) to the destination silo.
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
      interestCharge,
    });

    return created;
  });

  res.status(201).json(transfer);
}

/**
 * Reverse a transfer: move the seed back to the source silo (at the destination's
 * current MAP) and drop the transfer's journal entry, so the capitalised interest
 * accrual (20280) and inventory lines don't linger after the transfer row is gone.
 * This keeps Σ transfer.interestCharge in step with the 20280 balance.
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
    // Reverse the GL: remove the seed-move, capitalised hamali/transport and the
    // capitalised interest accrual posted at TRANSFER-<id>.
    await tx.journalEntry.deleteMany({ where: { reference: `TRANSFER-${transfer.id}` } });
    await tx.stockTransfer.delete({ where: { id: transfer.id } });
  });

  res.json({ message: 'Stock transfer reversed' });
}
