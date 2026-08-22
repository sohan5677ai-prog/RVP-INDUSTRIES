import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { createHamaliVerificationSchema } from '../schemas/hamaliVerification.schema.js';

export async function listHamaliVerifications(_req: Request, res: Response) {
  const rows = await prisma.hamaliVerification.findMany({
    orderBy: { asOfDate: 'desc' },
    include: {
      payments: { select: { id: true, amount: true, date: true, reference: true } },
    },
  });
  res.json(rows);
}

/**
 * Find (or create on first use) the single "Hamali Team" party that crew
 * settlement payments are booked against. Idempotent - never overwrites edits
 * made to the party in the Parties master.
 */
export async function getHamaliTeamParty(_req: Request, res: Response) {
  let party = await prisma.party.findFirst({ where: { type: 'HAMALI_TEAM' } });
  if (!party) {
    party = await prisma.party.create({
      data: { name: 'Bikash and Team', type: 'HAMALI_TEAM' },
    });
  }
  res.json(party);
}

/**
 * Record a reconciliation checkpoint: crew dues have been cross-verified with the
 * hamali crew through `asOfDate`. Verify-only marker - no GL posting. The actual
 * cash disbursement (if any) is recorded separately as a PAID ManualHamaliCost.
 */
export async function createHamaliVerification(req: Request, res: Response) {
  const data = createHamaliVerificationSchema.parse(req.body);

  const created = await prisma.hamaliVerification.create({
    data: {
      asOfDate: data.asOfDate,
      periodStart: data.periodStart ?? null,
      crewTotal: Math.round(data.crewTotal * 100) / 100,
      note: data.note ?? null,
      createdBy: req.user?.userId ?? null,
    },
  });

  res.status(201).json(created);
}

/** Undo a checkpoint - reopens the verified window for that period. */
export async function deleteHamaliVerification(req: Request, res: Response) {
  const row = await prisma.hamaliVerification.findUnique({ where: { id: req.params.id } });
  if (!row) throw new HttpError(404, 'Verification checkpoint not found');

  await prisma.hamaliVerification.delete({ where: { id: row.id } });
  res.json({ message: 'Verification checkpoint removed' });
}

/** Get all persisted rounded values as a dictionary { [id]: amount } */
export async function listHamaliRoundedValues(_req: Request, res: Response) {
  const rows = await prisma.hamaliRoundedValue.findMany();
  const result: Record<string, number> = {};
  for (const r of rows) {
    result[r.id] = Number(r.amount);
  }
  res.json(result);
}

/** Save or update a single rounded value */
export async function setHamaliRoundedValue(req: Request, res: Response) {
  const { id, amount } = req.body;
  if (!id || typeof id !== 'string') throw new HttpError(400, 'Invalid entry ID');
  if (typeof amount !== 'number' || isNaN(amount)) throw new HttpError(400, 'Invalid amount');

  const row = await prisma.hamaliRoundedValue.upsert({
    where: { id },
    create: { id, amount },
    update: { amount },
  });
  res.json({ id: row.id, amount: Number(row.amount) });
}

/** Remove a rounded value (reverting entry to formula default) */
export async function deleteHamaliRoundedValue(req: Request, res: Response) {
  const { id } = req.params;
  if (!id) throw new HttpError(400, 'Invalid entry ID');
  await prisma.hamaliRoundedValue.deleteMany({ where: { id } });
  res.json({ success: true });
}

/** Bulk upsert rounded values (used for initial sync from client localStorage) */
export async function bulkSetHamaliRoundedValues(req: Request, res: Response) {
  const { values } = req.body as { values: Record<string, number> };
  if (!values || typeof values !== 'object') throw new HttpError(400, 'Invalid values payload');

  const entries = Object.entries(values).filter(([, amt]) => typeof amt === 'number' && !isNaN(amt));
  if (entries.length > 0) {
    const ops = entries.map(([id, amount]) =>
      prisma.hamaliRoundedValue.upsert({
        where: { id },
        create: { id, amount },
        update: { amount },
      }),
    );
    await prisma.$transaction(ops);
  }
  res.json({ success: true, count: entries.length });
}
