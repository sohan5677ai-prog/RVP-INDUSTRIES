import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { LedgerService } from '../services/ledger.service.js';
import { createManualHamaliCostSchema, PER_BAG_TYPES } from '../schemas/manualHamaliCost.schema.js';

const LABELS: Record<string, string> = {
  BAG_CUTTING_NORMAL: 'Bag Cutting (Place A)',
  BAG_CUTTING_DISTANCE: 'Bag Cutting (Place B)',
  PAPPU_NET: 'Pappu Net',
  DIESEL: 'Diesel Cost',
  MISC: 'Miscellaneous',
  PAID: 'Paid to Hamali',
};

const isPerBag = (type: string) => (PER_BAG_TYPES as readonly string[]).includes(type);

export async function listManualHamaliCosts(_req: Request, res: Response) {
  const costs = await prisma.manualHamaliCost.findMany({ orderBy: { date: 'desc' } });
  res.json(costs);
}

/**
 * Record a manually-entered hamali cost that can't be derived from purchases or
 * sales. Two flavours:
 *   - Per-bag charge (bag cutting / pappu net): amount = bags × ratePerBag.
 *   - Flat amount (diesel / misc / paid): amount entered directly.
 *
 * GL posting:
 *   - Charges (bag cutting, pappu net, diesel, misc) accrue what we owe the crew:
 *       Dr Factory Labor Expense (50020) / Cr Hamali payable (20200).
 *   - PAID is a cash disbursement that settles that payable:
 *       Dr Hamali payable (20200) / Cr Cash-in-Hand (10410).
 */
export async function createManualHamaliCost(req: Request, res: Response) {
  const data = createManualHamaliCostSchema.parse(req.body);
  const perBag = isPerBag(data.type);

  const bags = perBag ? data.bags! : null;
  const ratePerBag = perBag ? data.ratePerBag! : null;
  const amount = Math.round((perBag ? bags! * ratePerBag! : data.amount!) * 100) / 100;

  const detail = perBag ? `${bags} bags × ₹${ratePerBag}` : `₹${amount}`;

  const cost = await prisma.$transaction(async (tx) => {
    const created = await tx.manualHamaliCost.create({
      data: {
        date: data.date,
        type: data.type,
        bags,
        ratePerBag,
        amount,
        note: data.note ?? null,
        createdBy: req.user?.userId ?? null,
      },
    });

    const lines =
      data.type === 'PAID'
        ? [
            { accountCode: '20200', debit: amount, credit: 0, costCenter: 'Hamali Team' }, // settle payable
            { accountCode: '10410', debit: 0, credit: amount }, // Cash-in-Hand
          ]
        : [
            { accountCode: '50020', debit: amount, credit: 0, costCenter: LABELS[data.type] }, // Factory Labor Expense
            { accountCode: '20200', debit: 0, credit: amount, costCenter: 'Hamali Team' }, // Hamali payable
          ];

    await LedgerService.postJournalEntry(tx, {
      date: data.date,
      reference: `MANUAL-HAMALI-${created.id}`,
      description: `${LABELS[data.type]} - ${detail}${data.note ? ` (${data.note})` : ''}`,
      lines,
    });

    return created;
  });

  res.status(201).json(cost);
}

/** Delete a manual hamali cost entry and reverse its GL posting. */
export async function deleteManualHamaliCost(req: Request, res: Response) {
  const cost = await prisma.manualHamaliCost.findUnique({ where: { id: req.params.id } });
  if (!cost) throw new HttpError(404, 'Cost entry not found');

  await prisma.$transaction(async (tx) => {
    await tx.journalEntry.deleteMany({ where: { reference: `MANUAL-HAMALI-${cost.id}` } });
    await tx.manualHamaliCost.delete({ where: { id: cost.id } });
  });

  res.json({ message: 'Cost entry deleted' });
}
