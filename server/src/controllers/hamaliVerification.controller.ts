import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { createHamaliVerificationSchema } from '../schemas/hamaliVerification.schema.js';

export async function listHamaliVerifications(_req: Request, res: Response) {
  const rows = await prisma.hamaliVerification.findMany({ orderBy: { asOfDate: 'desc' } });
  res.json(rows);
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
