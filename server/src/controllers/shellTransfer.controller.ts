import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { createShellTransferSchema } from '../schemas/purchase.schema.js';
import { shellTransferCost } from '../lib/calc.js';
import { InventoryService } from '../services/inventory.service.js';
import { LedgerService } from '../services/ledger.service.js';

const SHELL_STORAGE = 'Rampalli';

export async function listShellTransfers(_req: Request, res: Response) {
  const transfers = await prisma.shellTransfer.findMany({
    orderBy: { transferDate: 'desc' },
  });
  res.json(transfers);
}

/**
 * Record a tamarind-shell transfer from the process to the Rampalli storage.
 * Bears a fixed hamali (₹333/t packing + loading + unloading) and a ₹500
 * transport — both capitalised into the shell's value at Rampalli, where it is
 * later sold.
 */
export async function createShellTransfer(req: Request, res: Response) {
  const data = createShellTransferSchema.parse(req.body);

  const { hamaliCharge, transportCharge, totalCost } = shellTransferCost(data.weightKg);

  const transfer = await prisma.$transaction(async (tx) => {
    await InventoryService.addShellInventory(tx, SHELL_STORAGE, data.weightKg, totalCost);

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
 * Reverse a shell transfer: draw the weight back out of the Rampalli silo. Only
 * possible while that stock is still on hand (not yet sold). The journal entry is
 * left in place for audit.
 */
export async function deleteShellTransfer(req: Request, res: Response) {
  const transfer = await prisma.shellTransfer.findUnique({ where: { id: req.params.id } });
  if (!transfer) throw new HttpError(404, 'Shell transfer not found');

  const silo = await prisma.siloInventory.findFirst({
    where: { itemType: 'TAMARIND_SHELL', location: transfer.toLocation },
  });
  if (!silo || silo.weightKg < transfer.weightKg) {
    throw new HttpError(
      400,
      `Cannot reverse: ${transfer.toLocation} no longer holds ${transfer.weightKg} kg of shell (already sold)`
    );
  }

  await prisma.$transaction(async (tx) => {
    await InventoryService.consumeShellInventory(tx, transfer.toLocation, transfer.weightKg);
    await tx.shellTransfer.delete({ where: { id: transfer.id } });
  });

  res.json({ message: 'Shell transfer reversed' });
}
