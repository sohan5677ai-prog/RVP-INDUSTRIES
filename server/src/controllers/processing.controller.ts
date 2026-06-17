import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { createProcessingSchema, createPappuPriceSchema } from '../schemas/processing.schema.js';
import { calcPappu, DEFAULT_OUT_TURN_PCT } from '../lib/calc.js';
import { InventoryService } from '../services/inventory.service.js';
import { LedgerService } from '../services/ledger.service.js';

const processingInclude = {
  pappuPrice: true,
  purchase: {
    include: {
      stockIn: {
        include: {
          purchaseOrder: {
            include: {
              party: true,
            },
          },
        },
      },
    },
  },
} as const;

export async function listProcessing(_req: Request, res: Response) {
  const items = await prisma.processing.findMany({
    orderBy: { processDate: 'desc' },
    include: processingInclude,
  });
  res.json(items);
}

export async function createProcessing(req: Request, res: Response) {
  const data = createProcessingSchema.parse(req.body);
  const outTurn = data.outTurnPct ?? DEFAULT_OUT_TURN_PCT;
  const pappuWeightKg = calcPappu(data.blackWeightKg, outTurn);
  
  const huskWeightKg = Math.round(data.blackWeightKg * 0.25);
  const wasteWeightKg = Math.round(data.blackWeightKg * 0.10);
  const lostWeightKg = Math.round(data.blackWeightKg * 0.05);

  if (data.purchaseId) {
    const existing = await prisma.processing.findUnique({
      where: { purchaseId: data.purchaseId },
    });
    if (existing) {
      throw new HttpError(400, 'This purchase has already been processed');
    }
  }

  // Determine raw seed location
  let finalLocation: string = data.loadingLocation || 'At process';
  if (data.purchaseId) {
    const purchase = await prisma.purchase.findUnique({
      where: { id: data.purchaseId },
      include: { stockIn: true },
    });
    if (purchase && purchase.stockIn) {
      finalLocation = purchase.stockIn.loadingLocation;
    }
  }

  const overheadElectricity = data.overheadElectricity ?? 0;
  const overheadWages = data.overheadWages ?? 0;
  const overheadMaintenance = data.overheadMaintenance ?? 0;
  const totalOverheads = overheadElectricity + overheadWages + overheadMaintenance;

  // Check yield anomaly
  const actualPappuPct = (pappuWeightKg / data.blackWeightKg) * 100;
  const actualLossPct = (lostWeightKg / data.blackWeightKg) * 100;
  const isAnomaly = actualPappuPct < 59 || actualLossPct > 6;
  const anomalyReason = isAnomaly 
    ? `Yield deviation: Pappu yield is ${actualPappuPct.toFixed(1)}% (expected 60%) or lost shrinkage is ${actualLossPct.toFixed(1)}% (expected 5%).`
    : null;

  if (isAnomaly) {
    console.warn(`[YIELD ANOMALY ALERT] Batch process flags efficiency warning: ${anomalyReason}`);
  }

  const result = await prisma.$transaction(async (tx) => {
    // 1. Consume Raw stock from Silo Inventory
    const rawCost = await InventoryService.consumeBlackSeedInventory(tx, finalLocation, data.blackWeightKg);
    
    // 2. Create processing record
    const item = await tx.processing.create({
      data: {
        blackWeightKg: data.blackWeightKg,
        outTurnPct: outTurn,
        pappuWeightKg,
        huskWeightKg,
        wasteWeightKg,
        lostWeightKg,
        overheadElectricity,
        overheadWages,
        overheadMaintenance,
        loadingLocation: finalLocation,
        processDate: data.processDate,
        purchaseId: data.purchaseId || null,
      },
    });

    // 3. Post Ledger - Mill Start
    await LedgerService.postMillingStart(tx, item.id, rawCost, finalLocation, data.blackWeightKg);

    // 4. Calculate Finished Cost and Yield Variance (Abnormal Loss > 5%)
    const standardShrinkage = Math.round(data.blackWeightKg * 0.05);
    const huskValue = Math.round(huskWeightKg * 1.5 * 100) / 100;
    const wasteValue = Math.round(wasteWeightKg * 1.0 * 100) / 100;
    const byproductsCredit = huskValue + wasteValue;

    // Actual loss (shrinkage)
    const actualLostWeightKg = data.blackWeightKg - pappuWeightKg - huskWeightKg - wasteWeightKg;
    const abnormalLostWeightKg = Math.max(0, actualLostWeightKg - standardShrinkage);
    const avgRawCostPerKg = rawCost / data.blackWeightKg;
    const abnormalLossCost = Math.round(abnormalLostWeightKg * avgRawCostPerKg * 100) / 100;

    // finished cost = raw material cost + overheads - byproduct credits - abnormal loss written off
    const finishedPappuCost = Math.max(0, rawCost + totalOverheads - byproductsCredit - abnormalLossCost);

    // 5. Update finished Pappu inventory MAP
    await InventoryService.updateFinishedPappuInventory(tx, pappuWeightKg, finishedPappuCost);

    // 6. Post Ledger - Mill End
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

    return item;
  });

  const fullItem = await prisma.processing.findUnique({
    where: { id: result.id },
    include: processingInclude,
  });

  res.status(201).json({
    ...fullItem,
    yieldAnomaly: isAnomaly,
    yieldAnomalyReason: anomalyReason,
  });
}

export async function createPappuPrice(req: Request, res: Response) {
  const data = createPappuPriceSchema.parse(req.body);

  const processing = await prisma.processing.findUnique({
    where: { id: data.processingId },
    include: { pappuPrice: true },
  });
  if (!processing) throw new HttpError(400, 'Processing batch not found');
  if (processing.pappuPrice) throw new HttpError(409, 'Price already set for this batch');

  const price = await prisma.pappuPrice.create({
    data: { processingId: data.processingId, pricePerKg: data.pricePerKg },
  });
  res.status(201).json(price);
}

export async function updatePappuPrice(req: Request, res: Response) {
  const price = await prisma.pappuPrice.findUnique({
    where: { id: req.params.id },
  });
  if (!price) throw new HttpError(404, 'Price not found');

  const updated = await prisma.pappuPrice.update({
    where: { id: req.params.id },
    data: { pricePerKg: req.body.pricePerKg },
  });
  res.json(updated);
}

export async function deletePappuPrice(req: Request, res: Response) {
  const price = await prisma.pappuPrice.findUnique({
    where: { id: req.params.id },
  });
  if (!price) throw new HttpError(404, 'Price not found');

  await prisma.pappuPrice.delete({
    where: { id: req.params.id },
  });
  res.json({ message: 'Price deleted' });
}

export async function updateProcessing(req: Request, res: Response) {
  const data = createProcessingSchema.parse(req.body);
  const p = await prisma.processing.findUnique({
    where: { id: req.params.id },
  });
  if (!p) throw new HttpError(404, 'Processing run not found');

  if (data.purchaseId) {
    const existing = await prisma.processing.findFirst({
      where: { purchaseId: data.purchaseId, id: { not: req.params.id } },
    });
    if (existing) {
      throw new HttpError(400, 'This purchase has already been processed');
    }
  }

  const outTurn = data.outTurnPct ?? DEFAULT_OUT_TURN_PCT;
  const pappuWeightKg = calcPappu(data.blackWeightKg, outTurn);

  const huskWeightKg = Math.round(data.blackWeightKg * 0.25);
  const wasteWeightKg = Math.round(data.blackWeightKg * 0.10);
  const lostWeightKg = Math.round(data.blackWeightKg * 0.05);

  const updated = await prisma.processing.update({
    where: { id: req.params.id },
    data: {
      blackWeightKg: data.blackWeightKg,
      outTurnPct: outTurn,
      pappuWeightKg,
      huskWeightKg,
      wasteWeightKg,
      lostWeightKg,
      processDate: data.processDate,
      purchaseId: data.purchaseId || null,
    },
    include: processingInclude,
  });
  res.json(updated);
}

export async function deleteProcessing(req: Request, res: Response) {
  const p = await prisma.processing.findUnique({
    where: { id: req.params.id },
    include: { pappuPrice: true },
  });
  if (!p) throw new HttpError(404, 'Processing run not found');

  await prisma.$transaction(async (tx) => {
    if (p.pappuPrice) {
      await tx.pappuPrice.delete({ where: { processingId: req.params.id } });
    }
    await tx.processing.delete({ where: { id: req.params.id } });
  });
  res.json({ message: 'Processing run deleted' });
}
