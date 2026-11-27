import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { LedgerService } from '../services/ledger.service.js';
import { createManualHamaliCostSchema, PER_BAG_TYPES, PER_TONNE_TYPES } from '../schemas/manualHamaliCost.schema.js';
import { getHamaliRate } from './settings.controller.js';

const LABELS: Record<string, string> = {
  BAG_CUTTING_NORMAL: 'Bag Cutting (Place A)',
  BAG_CUTTING_DISTANCE: 'Bag Cutting (Place B)',
  PAPPU_NET: 'Pappu Net',
  TPS_BROKENS_PACKING: 'TPS Brokens Packing',
  TAMARIND_BYPRODUCTS_PACKING: 'Tamarind Byproducts Packing',
  PAPPU_TRANSFER: 'Pappu Transfer (Mill → Storage)',
  TARBAL_FEE: 'Tarbal Fee',
  MISC: 'Hamali Miscellaneous',
  PAID: 'Paid to Hamali',
  ADVANCE: 'Advance Given',
};

const isPerBag = (type: string) => (PER_BAG_TYPES as readonly string[]).includes(type);
const isPerTonne = (type: string) => (PER_TONNE_TYPES as readonly string[]).includes(type);

export async function listManualHamaliCosts(_req: Request, res: Response) {
  const costs = await prisma.manualHamaliCost.findMany({ orderBy: { date: 'desc' } });
  res.json(costs);
}

/**
 * Record a manually-entered hamali cost that can't be derived from purchases or
 * sales. Two flavours:
 *   - Per-bag charge (bag cutting / pappu net): amount = bags × ratePerBag.
 *   - Flat amount (misc / paid / advance): amount entered directly.
 *
 * GL posting:
 *   - Charges (bag cutting, pappu net, misc) accrue what we owe the crew:
 *       Dr Factory Labor Expense (50020) / Cr Hamali payable (20200).
 *   - PAID / ADVANCE is a cash disbursement that settles/reduces that payable:
 *       Dr Hamali payable (20200) / Cr Cash-in-Hand (10410).
 */
export async function createManualHamaliCost(req: Request, res: Response) {
  const cost = await recordManualHamaliCost(req.body, req.user?.userId ?? null);
  res.status(201).json(cost);
}

/**
 * Shared create path - also used by Stock → Pappu Stock, where a PAPPU_TRANSFER
 * row is both the stock movement (mill → storage) and its ₹270/t hamali charge.
 */
export async function recordManualHamaliCost(input: unknown, userId: string | null) {
  const data = createManualHamaliCostSchema.parse(input);
  const perBag = isPerBag(data.type);
  const perTonne = isPerTonne(data.type);

  const bags = perBag ? data.bags! : null;
  const ratePerBag = perBag ? data.ratePerBag! : null;
  const weightKg = perTonne ? data.weightKg! : null;
  // Rate falls back to Settings → Hamali Rates (Pappu Transfer, default ₹270/t).
  const ratePerTonne = perTonne ? (data.ratePerTonne ?? (await getHamaliRate('PAPPU_TRANSFER'))) : null;
  const raw = perBag ? bags! * ratePerBag! : perTonne ? (weightKg! / 1000) * ratePerTonne! : data.amount!;
  const amount = Math.round(raw * 100) / 100;

  const detail = perBag
    ? `${bags} bags × ₹${ratePerBag}`
    : perTonne
      ? `${(weightKg! / 1000).toFixed(3)} t × ₹${ratePerTonne}/t`
      : `₹${amount}`;
  const toLocation = perTonne ? (data.toLocation || null) : null;
  const lorryNumber = perTonne && data.lorryNumber ? data.lorryNumber.toUpperCase() : null;
  const where = toLocation ? ` → ${toLocation}` : '';

  return prisma.$transaction(async (tx) => {
    const created = await tx.manualHamaliCost.create({
      data: {
        date: data.date,
        type: data.type,
        bags,
        ratePerBag,
        weightKg,
        ratePerTonne,
        amount,
        note: data.note ?? null,
        toLocation,
        lorryNumber,
        createdBy: userId,
      },
    });

    const isDisbursement = data.type === 'PAID' || data.type === 'ADVANCE';
    const lines = isDisbursement
      ? [
          { accountCode: '20200', debit: amount, credit: 0, costCenter: 'Hamali Team' }, // settle/reduce payable
          { accountCode: '10410', debit: 0, credit: amount }, // Cash-in-Hand
        ]
      : [
          { accountCode: '50020', debit: amount, credit: 0, costCenter: LABELS[data.type] }, // Factory Labor Expense
          { accountCode: '20200', debit: 0, credit: amount, costCenter: 'Hamali Team' }, // Hamali payable
        ];

    await LedgerService.postJournalEntry(tx, {
      date: data.date,
      reference: `MANUAL-HAMALI-${created.id}`,
      description: `${LABELS[data.type]}${where} - ${detail}${data.note ? ` (${data.note})` : ''}`,
      lines,
    });

    return created;
  });
}

/** Delete a manual hamali cost entry and reverse its GL posting. */
export async function deleteManualHamaliCost(req: Request, res: Response) {
  const cost = await prisma.manualHamaliCost.findUnique({ where: { id: req.params.id } });
  if (!cost) throw new HttpError(404, 'Cost entry not found');
  await removeManualHamaliCost(cost.id);
  res.json({ message: 'Cost entry deleted' });
}

/** Delete one entry and its journal posting. */
export async function removeManualHamaliCost(id: string) {
  await prisma.$transaction(async (tx) => {
    await tx.journalEntry.deleteMany({ where: { reference: `MANUAL-HAMALI-${id}` } });
    await tx.manualHamaliCost.delete({ where: { id } });
  });
}
