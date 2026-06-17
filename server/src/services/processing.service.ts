import { Prisma } from '@prisma/client';
import { calcPappu, DEFAULT_OUT_TURN_PCT } from '../lib/calc.js';
import { InventoryService } from './inventory.service.js';
import { LedgerService } from './ledger.service.js';

export interface MillInput {
  purchaseId?: string | null;
  blackWeightKg: number;
  outTurnPct?: number;
  processDate: Date;
  loadingLocation: string;
  overheadElectricity?: number;
  overheadWages?: number;
  overheadMaintenance?: number;
}

export class ProcessingService {
  /**
   * Mill a batch of black seed into white pappu (+ byproducts): consumes raw
   * silo inventory, creates the Processing record, and posts the mill-start /
   * mill-end ledger entries. Shared by the manual processing endpoint and the
   * automatic transfer that runs when a purchase is verified.
   *
   * Must be called inside a transaction.
   */
  static async mill(tx: Prisma.TransactionClient, input: MillInput) {
    const outTurn = input.outTurnPct ?? DEFAULT_OUT_TURN_PCT;
    const blackWeightKg = input.blackWeightKg;
    const pappuWeightKg = calcPappu(blackWeightKg, outTurn);

    const huskWeightKg = Math.round(blackWeightKg * 0.25);
    const wasteWeightKg = Math.round(blackWeightKg * 0.1);
    const lostWeightKg = Math.round(blackWeightKg * 0.05);

    const overheadElectricity = input.overheadElectricity ?? 0;
    const overheadWages = input.overheadWages ?? 0;
    const overheadMaintenance = input.overheadMaintenance ?? 0;
    const totalOverheads = overheadElectricity + overheadWages + overheadMaintenance;

    // Yield anomaly check
    const actualPappuPct = (pappuWeightKg / blackWeightKg) * 100;
    const actualLossPct = (lostWeightKg / blackWeightKg) * 100;
    const isAnomaly = actualPappuPct < 59 || actualLossPct > 6;
    const anomalyReason = isAnomaly
      ? `Yield deviation: Pappu yield is ${actualPappuPct.toFixed(1)}% (expected 60%) or lost shrinkage is ${actualLossPct.toFixed(1)}% (expected 5%).`
      : null;
    if (isAnomaly) {
      console.warn(`[YIELD ANOMALY ALERT] Batch process flags efficiency warning: ${anomalyReason}`);
    }

    // 1. Consume raw stock from the source silo
    const rawCost = await InventoryService.consumeBlackSeedInventory(tx, input.loadingLocation, blackWeightKg);

    // 2. Create processing record
    const item = await tx.processing.create({
      data: {
        blackWeightKg,
        outTurnPct: outTurn,
        pappuWeightKg,
        huskWeightKg,
        wasteWeightKg,
        lostWeightKg,
        overheadElectricity,
        overheadWages,
        overheadMaintenance,
        loadingLocation: input.loadingLocation,
        processDate: input.processDate,
        purchaseId: input.purchaseId || null,
      },
    });

    // 3. Ledger - mill start
    await LedgerService.postMillingStart(tx, item.id, rawCost, input.loadingLocation, blackWeightKg);

    // 4. Finished cost + abnormal loss variance
    const standardShrinkage = Math.round(blackWeightKg * 0.05);
    const huskValue = Math.round(huskWeightKg * 1.5 * 100) / 100;
    const wasteValue = Math.round(wasteWeightKg * 1.0 * 100) / 100;
    const byproductsCredit = huskValue + wasteValue;

    const actualLostWeightKg = blackWeightKg - pappuWeightKg - huskWeightKg - wasteWeightKg;
    const abnormalLostWeightKg = Math.max(0, actualLostWeightKg - standardShrinkage);
    const avgRawCostPerKg = blackWeightKg > 0 ? rawCost / blackWeightKg : 0;
    const abnormalLossCost = Math.round(abnormalLostWeightKg * avgRawCostPerKg * 100) / 100;

    const finishedPappuCost = Math.max(0, rawCost + totalOverheads - byproductsCredit - abnormalLossCost);

    // 5. Update finished pappu inventory MAP
    await InventoryService.updateFinishedPappuInventory(tx, pappuWeightKg, finishedPappuCost);

    // 6. Ledger - mill end
    await LedgerService.postMillingEnd(tx, item.id, {
      rawMaterialCost: rawCost,
      pappuWeightKg,
      finishedPappuCost,
      huskWeightKg,
      wasteWeightKg,
      overheadElectricity,
      overheadWages,
      overheadMaintenance,
      abnormalLossCost,
    });

    return { item, yieldAnomaly: isAnomaly, yieldAnomalyReason: anomalyReason };
  }
}
