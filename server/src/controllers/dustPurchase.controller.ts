import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { createDustPurchaseSchema } from '../schemas/purchase.schema.js';
import { LedgerService } from '../services/ledger.service.js';

export async function listDustPurchases(_req: Request, res: Response) {
  const purchases = await prisma.dustPurchase.findMany({
    orderBy: { purchaseDate: 'desc' },
    include: { party: { select: { id: true, name: true } } },
  });
  res.json(purchases);
}

/**
 * Record a pre-cleaner dust purchase from an outside party. Unlike a ShellTransfer
 * (which only moves our own byproduct to storage), this raises a real supplier
 * payable - it therefore shows up on the party's ledger. The payable amount is
 * weightKg × pricePerKg; the GL posting is Dr 50120 / Cr 20100 (see
 * LedgerService.postDustPurchase).
 */
export async function createDustPurchase(req: Request, res: Response) {
  const data = createDustPurchaseSchema.parse(req.body);

  const party = await prisma.party.findUnique({ where: { id: data.partyId } });
  if (!party) throw new HttpError(404, 'Party not found');

  const amount = Math.round(data.weightKg * data.pricePerKg * 100) / 100;

  const purchase = await prisma.$transaction(async (tx) => {
    const created = await tx.dustPurchase.create({
      data: {
        partyId: data.partyId,
        weightKg: data.weightKg,
        pricePerKg: data.pricePerKg,
        amount,
        lorryNumber: data.lorryNumber ?? null,
        invoiceNumber: data.invoiceNumber ?? null,
        purchaseDate: data.purchaseDate,
      },
    });

    await LedgerService.postDustPurchase(tx, created.id, {
      date: data.purchaseDate,
      amount,
      weightKg: data.weightKg,
      partyName: party.name,
    });

    return created;
  });

  const withParty = await prisma.dustPurchase.findUnique({
    where: { id: purchase.id },
    include: { party: { select: { id: true, name: true } } },
  });
  res.status(201).json(withParty);
}

/**
 * Reverse a dust purchase - removes the record and its expense/payable posting so
 * the party ledger and P/L are corrected.
 */
export async function deleteDustPurchase(req: Request, res: Response) {
  const purchase = await prisma.dustPurchase.findUnique({ where: { id: req.params.id } });
  if (!purchase) throw new HttpError(404, 'Dust purchase not found');

  await prisma.$transaction(async (tx) => {
    await tx.journalEntry.deleteMany({ where: { reference: `DUST-PURCHASE-${purchase.id}` } });
    await tx.dustPurchase.delete({ where: { id: purchase.id } });
  });

  res.json({ message: 'Dust purchase reversed' });
}
