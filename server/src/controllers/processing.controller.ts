import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { createProcessingSchema } from '../schemas/processing.schema.js';
import { calcPappu, DEFAULT_OUT_TURN_PCT } from '../lib/calc.js';
import { ProcessingService } from '../services/processing.service.js';

const processingInclude = {
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

  if (data.purchaseId) {
    const existing = await prisma.processing.findUnique({
      where: { purchaseId: data.purchaseId },
    });
    if (existing) {
      throw new HttpError(400, 'This purchase has already been processed');
    }
  }

  // Determine raw seed location: a purchase-linked run mills from its arrival
  // silo; a standalone run mills from the chosen pool.
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

  const result = await prisma.$transaction((tx) =>
    ProcessingService.mill(tx, {
      purchaseId: data.purchaseId || null,
      blackWeightKg: data.blackWeightKg,
      outTurnPct: data.outTurnPct ?? DEFAULT_OUT_TURN_PCT,
      processDate: data.processDate,
      loadingLocation: finalLocation,
      overheadElectricity: data.overheadElectricity ?? 0,
      overheadWages: data.overheadWages ?? 0,
      overheadMaintenance: data.overheadMaintenance ?? 0,
    })
  );

  const fullItem = await prisma.processing.findUnique({
    where: { id: result.item.id },
    include: processingInclude,
  });

  res.status(201).json({
    ...fullItem,
    yieldAnomaly: result.yieldAnomaly,
    yieldAnomalyReason: result.yieldAnomalyReason,
  });
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
  });
  if (!p) throw new HttpError(404, 'Processing run not found');

  await prisma.processing.delete({ where: { id: req.params.id } });
  res.json({ message: 'Processing run deleted' });
}
