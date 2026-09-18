import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { createShellTransferSchema } from '../schemas/purchase.schema.js';
import { shellTransferCost } from '../lib/calc.js';
import { LedgerService } from '../services/ledger.service.js';

export async function listShellTransfers(_req: Request, res: Response) {
  const transfers = await prisma.shellTransfer.findMany({
    orderBy: { transferDate: 'desc' },
  });
  res.json(transfers);
}

type ShellTransferInput = Parameters<typeof createShellTransferSchema.parse>[0];

export async function recordShellTransfer(
  input: ShellTransferInput,
  weighbridgeTicketId?: string,
) {
  const data = createShellTransferSchema.parse(input);
  if (weighbridgeTicketId) {
    const existing = await prisma.shellTransfer.findUnique({ where: { weighbridgeTicketId } });
    if (existing) return existing;
  }

  const { getHamaliRate } = await import('./settings.controller.js');
  const { hamaliCharge, transportCharge, totalCost } = shellTransferCost(
    data.weightKg,
    await getHamaliRate('SHELL_TRANSFER'),
    data.toLocation
  );

  return prisma.$transaction(async (tx) => {
    const created = await tx.shellTransfer.create({
      data: {
        toLocation: data.toLocation,
        material: data.material,
        weightKg: data.weightKg,
        lorryNumber: data.lorryNumber ?? null,
        hamaliCharge,
        transportCharge,
        totalCost,
        transferDate: data.transferDate,
        weighbridgeTicketId: weighbridgeTicketId ?? null,
      },
    });

    await LedgerService.postShellTransfer(tx, created.id, {
      toLocation: data.toLocation,
      weightKg: data.weightKg,
      hamaliCharge,
      transportCharge,
    });

    return created;
  });
}

/**
 * Record a tamarind-shell transfer from the process to another location. Shell is
 * NOT held as a valued silo - this is only a physical-movement + cost record. The
 * fixed hamali (₹333/t packing + loading + unloading) and transport are expensed
 * (see LedgerService.postShellTransfer). Shell is later sold straight from the
 * shared 10% "Pre Cleaner Husk & Tamarind" pool, like Waste.
 */
export async function createShellTransfer(req: Request, res: Response) {
  const transfer = await recordShellTransfer(req.body);
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
