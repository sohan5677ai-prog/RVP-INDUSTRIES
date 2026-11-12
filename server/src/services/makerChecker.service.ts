import { Prisma, type PendingChange, type Role } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { HttpError } from '../lib/httpError.js';
import { isPermission, type Permission } from '../lib/permissions.js';
import { permissionsFor } from './permission.service.js';

/**
 * Maker-checker: a change one person proposes and another releases
 * (plan items 2.4, 2.5 and 2.6).
 *
 * The framework only. Nothing is routed through it in Phase 2 — Phase 3
 * attaches vendor bank details, which is where the fraud this exists to stop
 * actually happens. Shipping the machinery first means that phase is
 * registering an applier rather than inventing a workflow under time pressure.
 *
 * Two rules are enforced here rather than left to each caller, because a rule
 * each caller has to remember is one some caller will forget:
 *
 *   1. **The requester cannot decide.** Not even with the permission, not even
 *      as DEVELOPER. A segregation rule that the most privileged account can
 *      step around protects nothing, since that is the account an attacker
 *      wants anyway.
 *   2. **The approver needs the permission the request names**, as recorded
 *      when it was raised — so changing the permission map later cannot lower
 *      the bar for requests already in flight.
 */

/** Applies an approved change. Registered per subject. */
export type Applier = (change: PendingChange) => Promise<void>;

const appliers = new Map<string, Applier>();

/**
 * Register how a subject's approved change is carried out.
 *
 * A subject with no applier can still be requested and approved, but applying
 * will fail loudly rather than silently doing nothing — which is the right
 * behaviour for a half-wired workflow.
 */
export function registerApplier(subject: string, applier: Applier): void {
  appliers.set(subject, applier);
}

export function hasApplier(subject: string): boolean {
  return appliers.has(subject);
}

/** Only for tests, to keep registrations from leaking between them. */
export function clearAppliers(): void {
  appliers.clear();
}

export interface ChangeRequest {
  subject: string;
  subjectId?: string | null;
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  proposed: unknown;
  previous?: unknown;
  summary: string;
  approvePermission: Permission;
  amount?: number | null;
  requestedById: string;
  requestedByName?: string | null;
}

export async function requestChange(input: ChangeRequest): Promise<PendingChange> {
  if (!isPermission(input.approvePermission)) {
    throw new HttpError(500, `Unknown approval permission: ${input.approvePermission}`);
  }
  return prisma.pendingChange.create({
    data: {
      subject: input.subject,
      subjectId: input.subjectId ?? null,
      action: input.action,
      proposed: input.proposed as Prisma.InputJsonValue,
      previous: (input.previous ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      summary: input.summary.slice(0, 500),
      approvePermission: input.approvePermission,
      amount: input.amount == null ? null : new Prisma.Decimal(input.amount),
      requestedById: input.requestedById,
      requestedByName: input.requestedByName ?? null,
    },
  });
}

export interface Decider {
  userId: string;
  name?: string | null;
  role: Role;
}

/**
 * The amount a role may approve for a subject. Null means no limit, which is
 * also what no configuration means.
 */
export async function approvalLimitFor(role: Role, subject: string): Promise<number | null> {
  try {
    const row = await prisma.approvalLimit.findUnique({
      where: { role_subject: { role, subject } },
      select: { maxAmount: true },
    });
    return row?.maxAmount == null ? null : Number(row.maxAmount);
  } catch (err) {
    // Unlike the permission lookup, this fails CLOSED-ish: returning null here
    // would mean "unlimited", so an unreachable database must not quietly
    // raise someone's approval ceiling. Zero refuses every non-zero amount.
    logger.error('approval limit lookup failed; refusing to assume unlimited', err);
    return 0;
  }
}

/** Why a decision was refused, for a message the approver can act on. */
type Refusal =
  | { ok: true }
  | { ok: false; status: number; message: string };

async function mayDecide(change: PendingChange, decider: Decider): Promise<Refusal> {
  if (change.status !== 'PENDING') {
    return { ok: false, status: 409, message: 'That request has already been decided.' };
  }

  // Rule 1: segregation of duties. Checked before the permission, so the
  // message says the useful thing rather than "you lack a permission" to
  // someone who in fact holds it.
  if (change.requestedById === decider.userId) {
    return {
      ok: false,
      status: 403,
      message: 'You raised this request, so someone else has to approve it.',
    };
  }

  const held = await permissionsFor(decider.role);
  if (!isPermission(change.approvePermission) || !held.has(change.approvePermission)) {
    return {
      ok: false,
      status: 403,
      message: 'You do not have permission to approve this.',
    };
  }

  return { ok: true };
}

/**
 * Approve and carry out a change.
 *
 * The approval and the application are separate states on purpose. If applying
 * throws, the row lands in FAILED with the error rather than staying PENDING
 * (which would invite a second approval of something half-done) or showing
 * APPLIED (which would be a lie).
 */
export async function approveChange(id: string, decider: Decider): Promise<PendingChange> {
  const change = await prisma.pendingChange.findUnique({ where: { id } });
  if (!change) throw new HttpError(404, 'Request not found');

  const verdict = await mayDecide(change, decider);
  if (!verdict.ok) throw new HttpError(verdict.status, verdict.message);

  // Rule 2: approval limits (plan item 2.5).
  if (change.amount != null) {
    const limit = await approvalLimitFor(decider.role, change.subject);
    const amount = Number(change.amount);
    if (limit != null && amount > limit) {
      throw new HttpError(
        403,
        `This is above what your role may approve (limit ${limit.toLocaleString('en-IN')}). It needs someone more senior.`
      );
    }
  }

  // Claim it first, conditionally, so two approvers clicking at once cannot
  // both get through and apply the change twice.
  const claimed = await prisma.pendingChange.updateMany({
    where: { id, status: 'PENDING' },
    data: {
      status: 'APPROVED',
      decidedById: decider.userId,
      decidedByName: decider.name ?? null,
      decidedAt: new Date(),
    },
  });
  if (claimed.count !== 1) {
    throw new HttpError(409, 'That request has already been decided.');
  }

  const applier = appliers.get(change.subject);
  if (!applier) {
    await prisma.pendingChange.update({
      where: { id },
      data: { status: 'FAILED', error: `No applier registered for subject "${change.subject}"` },
    });
    throw new HttpError(500, 'This kind of change cannot be applied yet.');
  }

  try {
    await applier(change);
    return prisma.pendingChange.update({
      where: { id },
      data: { status: 'APPLIED', appliedAt: new Date() },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`applying pending change ${id} failed`, err);
    await prisma.pendingChange.update({
      where: { id },
      data: { status: 'FAILED', error: message.slice(0, 500) },
    });
    throw new HttpError(500, 'The change was approved but could not be applied.');
  }
}

/** Reject a change. A reason is required: a refusal without one is not a decision. */
export async function rejectChange(
  id: string,
  decider: Decider,
  reason: string
): Promise<PendingChange> {
  const trimmed = reason.trim();
  if (trimmed.length < 3) {
    throw new HttpError(400, 'Give a reason for rejecting this.');
  }

  const change = await prisma.pendingChange.findUnique({ where: { id } });
  if (!change) throw new HttpError(404, 'Request not found');

  const verdict = await mayDecide(change, decider);
  if (!verdict.ok) throw new HttpError(verdict.status, verdict.message);

  const claimed = await prisma.pendingChange.updateMany({
    where: { id, status: 'PENDING' },
    data: {
      status: 'REJECTED',
      decidedById: decider.userId,
      decidedByName: decider.name ?? null,
      decidedAt: new Date(),
      decisionReason: trimmed.slice(0, 500),
    },
  });
  if (claimed.count !== 1) {
    throw new HttpError(409, 'That request has already been decided.');
  }

  return prisma.pendingChange.findUniqueOrThrow({ where: { id } });
}

/** Requests still waiting, newest first. */
export async function listPending(subject?: string): Promise<PendingChange[]> {
  return prisma.pendingChange.findMany({
    where: { status: 'PENDING', ...(subject ? { subject } : {}) },
    orderBy: { requestedAt: 'desc' },
    take: 200,
  });
}
