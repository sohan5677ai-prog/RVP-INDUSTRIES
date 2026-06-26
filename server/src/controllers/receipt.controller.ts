import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { createReceiptSchema } from '../schemas/receipt.schema.js';
import { LedgerService } from '../services/ledger.service.js';
import { extractTransactionData } from '../lib/gemini.js';

/**
 * Read an uploaded receipt screenshot (bank/UPI/cheque) with Gemini and return
 * the fields it could extract, so the client can pre-fill the receipt form. The
 * counterparty here is whoever PAID US, so we offer buyers as the known-party
 * candidates for matching. Nothing is persisted.
 */
export async function extractReceiptScreenshot(req: Request, res: Response) {
  if (!req.file) throw new HttpError(400, 'Screenshot file is required');
  const buyers = await prisma.party.findMany({ where: { type: 'BUYER' }, select: { name: true } });
  const candidates = [...new Set(buyers.map((b) => b.name).filter(Boolean))];
  const data = await extractTransactionData(req.file.buffer, req.file.mimetype, 'receipt', candidates);
  console.log('[extract:receipt]', JSON.stringify(data));
  res.json(data);
}

export async function listReceipts(req: Request, res: Response) {
  const receipts = await prisma.receipt.findMany({
    orderBy: { date: 'desc' },
    include: {
      party: true,
    },
  });
  res.json(receipts);
}

export async function createReceipt(req: Request, res: Response) {
  const data = createReceiptSchema.parse(req.body);

  const receipt = await prisma.$transaction(async (tx) => {
    let partyName = undefined;
    if (data.partyId) {
      const party = await tx.party.findUnique({ where: { id: data.partyId } });
      if (!party) throw new HttpError(404, 'Party not found');
      partyName = party.name;
    }

    const created = await tx.receipt.create({
      data: {
        date: data.date,
        amount: data.amount,
        type: data.type,
        partyId: data.partyId ?? null,
        reference: data.reference ?? null,
        description: data.description ?? null,
      },
    });

    await LedgerService.postReceipt(tx, created.id, {
      date: data.date,
      amount: data.amount,
      type: data.type,
      partyName,
      reference: data.reference ?? undefined,
      description: data.description ?? undefined,
    });

    const journalEntry = await tx.journalEntry.findFirst({
      where: { reference: `RECEIPT-${created.id}` },
    });

    if (journalEntry) {
      return tx.receipt.update({
        where: { id: created.id },
        data: { journalEntryId: journalEntry.id },
        include: { party: true },
      });
    }

    return created;
  });

  res.json(receipt);
}

export async function deleteReceipt(req: Request, res: Response) {
  const receipt = await prisma.receipt.findUnique({ where: { id: req.params.id } });
  if (!receipt) throw new HttpError(404, 'Receipt not found');

  await prisma.$transaction(async (tx) => {
    if (receipt.journalEntryId) {
      await tx.journalEntry.delete({ where: { id: receipt.journalEntryId } });
    } else {
      await tx.receipt.delete({ where: { id: receipt.id } });
    }
  });

  res.json({ message: 'Receipt deleted' });
}
