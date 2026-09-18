import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { createHuskTransferSchema } from '../schemas/purchase.schema.js';
import { shellTransferCost } from '../lib/calc.js';
import { LedgerService } from '../services/ledger.service.js';

export async function listHuskTransfers(_req: Request, res: Response) {
  const transfers = await prisma.huskTransfer.findMany({
    orderBy: { transferDate: 'desc' },
  });
  res.json(transfers);
}

type HuskTransferInput = Parameters<typeof createHuskTransferSchema.parse>[0];

export async function recordHuskTransfer(
  input: HuskTransferInput,
  weighbridgeTicketId?: string,
) {
  const data = createHuskTransferSchema.parse(input);
  if (weighbridgeTicketId) {
    const existing = await prisma.huskTransfer.findUnique({ where: { weighbridgeTicketId } });
    if (existing) return existing;
  }

  const { getHamaliRate } = await import('./settings.controller.js');
  const { hamaliCharge, transportCharge, totalCost } = shellTransferCost(
    data.weightKg,
    await getHamaliRate('SHELL_TRANSFER'),
    data.toLocation
  );

  return prisma.$transaction(async (tx) => {
    const created = await tx.huskTransfer.create({
      data: {
        toLocation: data.toLocation,
        weightKg: data.weightKg,
        lorryNumber: data.lorryNumber ?? null,
        hamaliCharge,
        transportCharge,
        totalCost,
        transferDate: data.transferDate,
        weighbridgeTicketId: weighbridgeTicketId ?? null,
      },
    });

    await LedgerService.postHuskTransfer(tx, created.id, {
      toLocation: data.toLocation,
      weightKg: data.weightKg,
      hamaliCharge,
      transportCharge,
    });

    return created;
  });
}

/**
 * Record a husk transfer from the factory to a storage location (PGR COLD /
 * Murugan / KNM Multi). Husk is not held as a valued silo - this is only a
 * physical-movement + cost record. The fixed hamali (₹333/t packing + loading +
 * unloading) and transport (₹500) are expensed (see LedgerService.postHuskTransfer).
 */
export async function createHuskTransfer(req: Request, res: Response) {
  const transfer = await recordHuskTransfer(req.body);
  res.status(201).json(transfer);
}

/**
 * Reverse a husk transfer: remove the movement record and its cost posting so the
 * P/L is corrected.
 */
export async function deleteHuskTransfer(req: Request, res: Response) {
  const transfer = await prisma.huskTransfer.findUnique({ where: { id: req.params.id } });
  if (!transfer) throw new HttpError(404, 'Husk transfer not found');

  await prisma.$transaction(async (tx) => {
    await tx.journalEntry.deleteMany({ where: { reference: `HUSK-TRANSFER-${transfer.id}` } });
    await tx.huskTransfer.delete({ where: { id: transfer.id } });
  });

  res.json({ message: 'Husk transfer reversed' });
}
