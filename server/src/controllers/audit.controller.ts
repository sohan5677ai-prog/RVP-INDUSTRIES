import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { invalidatePeriodLockCache } from '../lib/periodLock.js';
import { recordAudit, verifyAuditChain } from '../services/audit.service.js';

/**
 * Reading the audit trail, verifying it, and closing periods
 * (plan items 4.3, 4.5, 4.7).
 */

const listSchema = z.object({
  userId: z.string().optional(),
  entity: z.string().optional(),
  entityId: z.string().optional(),
  action: z.string().optional(),
  requestId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  take: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().optional(),
});

/**
 * The viewer's backing query (plan item 4.7).
 *
 * Cursor-paged on `seq` rather than offset-paged: the table only ever grows,
 * and an offset page would shift under the reader as new rows arrive.
 */
export async function listAuditLog(req: Request, res: Response) {
  const q = listSchema.parse(req.query);

  const where: Record<string, unknown> = {};
  if (q.userId) where.userId = q.userId;
  if (q.entity) where.entity = q.entity;
  if (q.entityId) where.entityId = q.entityId;
  if (q.requestId) where.requestId = q.requestId;
  // Prefix match, so "payment." finds every payment action rather than
  // needing the exact verb.
  if (q.action) where.action = { startsWith: q.action };
  if (q.from || q.to) {
    where.createdAt = {
      ...(q.from ? { gte: new Date(q.from) } : {}),
      ...(q.to ? { lte: new Date(q.to) } : {}),
    };
  }
  if (q.cursor) where.seq = { lt: BigInt(q.cursor) };

  const rows = await prisma.auditLog.findMany({
    where,
    orderBy: { seq: 'desc' },
    take: q.take,
  });

  res.json({
    // BigInt does not survive JSON.stringify; the client only ever displays it
    // or passes it back as a cursor.
    rows: rows.map((r) => ({ ...r, seq: String(r.seq) })),
    nextCursor: rows.length === q.take ? String(rows[rows.length - 1].seq) : null,
  });
}

/**
 * Verify the hash chain (plan item 4.3).
 *
 * Deliberately a normal authenticated endpoint rather than only a command-line
 * tool: the people who need to know the trail is intact are the ones using the
 * app, and a check that requires shell access is a check that never gets run.
 */
export async function verifyAuditLog(_req: Request, res: Response) {
  const report = await verifyAuditChain();
  // Verifying is itself an auditable act - it is the evidence that someone
  // looked, and when.
  await recordAudit({
    action: 'audit.verify',
    newValues: { ok: report.ok, checked: report.checked, failures: report.failures.length },
  });
  res.json(report);
}

/* ------------------------------------------------------------ period lock */

const lockSchema = z.object({
  fromDate: z.string(),
  toDate: z.string(),
  reason: z.string().max(300).optional(),
});

export async function listPeriodLocks(_req: Request, res: Response) {
  res.json(
    await prisma.periodLock.findMany({ orderBy: { fromDate: 'desc' }, take: 100 })
  );
}

export async function createPeriodLock(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  const { fromDate, toDate, reason } = lockSchema.parse(req.body);

  const from = new Date(fromDate);
  const to = new Date(toDate);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new HttpError(400, 'Give a valid date range.');
  }
  if (to < from) throw new HttpError(400, 'The end of the period is before its start.');

  const clash = await prisma.periodLock.findFirst({
    where: { unlockedAt: null, fromDate: { lte: to }, toDate: { gte: from } },
  });
  if (clash) {
    throw new HttpError(409, 'That range overlaps a period that is already closed.');
  }

  const actor = await prisma.user.findUnique({
    where: { id: req.user.userId },
    select: { name: true },
  });

  const lock = await prisma.periodLock.create({
    data: {
      fromDate: from,
      toDate: to,
      reason: reason ?? null,
      lockedById: req.user.userId,
      lockedByName: actor?.name ?? null,
    },
  });
  invalidatePeriodLockCache();
  res.status(201).json(lock);
}

/**
 * Reopen a closed period.
 *
 * The row is updated, never deleted, so the fact that a closed period was
 * reopened - by whom, when and why - survives. A reason is required: reopening
 * a filed year without one is exactly the event an auditor will ask about.
 */
export async function releasePeriodLock(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  const { reason } = z.object({ reason: z.string().min(3).max(300) }).parse(req.body);

  const lock = await prisma.periodLock.findUnique({ where: { id: req.params.id } });
  if (!lock) throw new HttpError(404, 'No such period');
  if (lock.unlockedAt) throw new HttpError(409, 'That period is already open.');

  const actor = await prisma.user.findUnique({
    where: { id: req.user.userId },
    select: { name: true },
  });

  const updated = await prisma.periodLock.update({
    where: { id: lock.id },
    data: {
      unlockedAt: new Date(),
      unlockedById: req.user.userId,
      unlockedByName: actor?.name ?? null,
      unlockReason: reason,
    },
  });
  invalidatePeriodLockCache();
  res.json(updated);
}
