import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { createShellTransferSchema } from '../schemas/purchase.schema.js';
import { shellTransferCost } from '../lib/calc.js';
import { LedgerService } from '../services/ledger.service.js';

const SHELL_STORAGE = 'PGR COLD';

export async function listShellTransfers(_req: Request, res: Response) {
  const transfers = await prisma.shellTransfer.findMany({
    orderBy: { transferDate: 'desc' },
  });
  res.json(transfers);
}

/**
 * Record a tamarind-shell transfer from the process to another location. Shell is
 * NOT held as a valued silo - this is only a physical-movement + cost record. The
 * fixed hamali (₹333/t packing + loading + unloading) and transport are expensed
 * (see LedgerService.postShellTransfer). Shell is later sold straight from the
 * shared 10% "Pre Cleaner Husk & Tamarind" pool, like Waste.
 */
export async function createShellTransfer(req: Request, res: Response) {
  const data = createShellTransferSchema.parse(req.body);

  const { getHamaliRate } = await import('./settings.controller.js');
  const { hamaliCharge, transportCharge, totalCost } = shellTransferCost(
    data.weightKg,
    await getHamaliRate('SHELL_TRANSFER'),
    SHELL_STORAGE
  );

  const transfer = await prisma.$transaction(async (tx) => {
    const created = await tx.shellTransfer.create({
      data: {
        toLocation: SHELL_STORAGE,
        weightKg: data.weightKg,
        lorryNumber: data.lorryNumber ?? null,
        hamaliCharge,
        transportCharge,
        totalCost,
        transferDate: data.transferDate,
      },
    });

    await LedgerService.postShellTransfer(tx, created.id, {
      toLocation: SHELL_STORAGE,
      weightKg: data.weightKg,
      hamaliCharge,
      transportCharge,
    });

    return created;
  });

  res.status(201).json(transfer);
}

/**
 * Reverse a shell transfer. Shell is no longer a valued silo, so this just removes
 * the movement record and reverses its cost posting. The transfer's expense
 * journal entry is deleted so the P/L is corrected.
 */
export async function deleteShellTransfer(req: Request, res: Response) {
  const transfer = await prisma.shellTransfer.findUnique({ where: { id: req.params.id } });
  if (!transfer) throw new HttpError(404, 'Shell transfer not found');

  await prisma.$transaction(async (tx) => {
    await tx.journalEntry.deleteMany({ where: { reference: `SHELL-TRANSFER-${transfer.id}` } });
    await tx.shellTransfer.delete({ where: { id: transfer.id } });
  });

  res.json({ message: 'Shell transfer reversed' });
}
