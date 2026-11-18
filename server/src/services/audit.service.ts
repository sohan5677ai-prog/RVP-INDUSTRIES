import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma, registerAuditHooks } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { GENESIS_HASH, hashRow, verifyChain, type StoredRow } from '../lib/auditChain.js';
import { currentContext } from '../lib/requestContext.js';

/**
 * Writing and verifying the audit trail (plan items 4.1, 4.2, 4.3).
 */

/**
 * Fields that must never reach the log, whatever table they came from.
 *
 * An audit trail that records a password hash or a TOTP secret has turned
 * itself into a second credential store - and one that is, by design, never
 * deleted. Matched by name across every model rather than per-model, so a new
 * table with a `password` column is covered the day it is added.
 */
const REDACTED_FIELDS = new Set([
  'password',
  'mfaSecret',
  'refreshTokenHash',
  'tokenHash',
  'codeHash',
  'hash',
  'prevHash',
  'taxproGspSecret',
  'taxproGstPass',
]);

/** Values too large to be worth keeping in full. */
const MAX_VALUE_CHARS = 2000;

export function redact(values: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (values === null || values === undefined) return Prisma.JsonNull;
  if (typeof values !== 'object') return values as Prisma.InputJsonValue;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    if (REDACTED_FIELDS.has(key)) {
      out[key] = '[redacted]';
      continue;
    }
    if (value instanceof Date) {
      out[key] = value.toISOString();
      continue;
    }
    if (typeof value === 'bigint') {
      out[key] = value.toString();
      continue;
    }
    if (typeof value === 'string' && value.length > MAX_VALUE_CHARS) {
      out[key] = `${value.slice(0, MAX_VALUE_CHARS)}…[truncated]`;
      continue;
    }
    // Prisma Decimal and similar objects stringify usefully; plain objects are
    // kept as-is so nested changes stay readable.
    out[key] = value;
  }
  return out as Prisma.InputJsonValue;
}

export interface AuditEvent {
  action: string;
  entity?: string | null;
  entityId?: string | null;
  entityLabel?: string | null;
  oldValues?: unknown;
  newValues?: unknown;
}

/**
 * Append one row, extending the chain.
 *
 * The chain means rows cannot be written independently: each needs the hash of
 * the one before. That is serialised inside a transaction which locks the
 * current tail, so two concurrent writers queue rather than both claiming the
 * same sequence number. With a handful of users the contention is negligible,
 * and the alternative - letting sequences collide and repairing later - would
 * make the one property the chain exists for unreliable.
 *
 * Never throws. A failure to audit must not fail the business operation that
 * triggered it; it is logged loudly instead, and a gap in `seq` is itself
 * visible to the verifier.
 */
export async function recordAudit(event: AuditEvent): Promise<void> {
  const context = currentContext();

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await prisma.$transaction(async (tx) => {
        // Lock the tail so a concurrent writer waits rather than racing us to
        // the same seq. On an empty table there is nothing to lock, which the
        // unique constraint on seq catches instead - hence the retry.
        const tail = await tx.$queryRaw<{ seq: bigint; hash: string }[]>`
          SELECT "seq", "hash" FROM "AuditLog" ORDER BY "seq" DESC LIMIT 1 FOR UPDATE
        `;

        const prevHash = tail[0]?.hash ?? GENESIS_HASH;
        const seq = (tail[0]?.seq ?? 0n) + 1n;
        const createdAt = new Date();

        const hash = hashRow(
          {
            seq,
            action: event.action,
            entity: event.entity ?? null,
            entityId: event.entityId ?? null,
            oldValues: event.oldValues ?? null,
            newValues: event.newValues ?? null,
            userId: context?.userId ?? null,
            ip: context?.ip ?? null,
            requestId: context?.requestId ?? null,
            createdAt,
          },
          prevHash
        );

        await tx.auditLog.create({
          data: {
            seq,
            hash,
            prevHash,
            action: event.action,
            entity: event.entity ?? null,
            entityId: event.entityId ?? null,
            entityLabel: event.entityLabel ?? null,
            oldValues: redact(event.oldValues),
            newValues: redact(event.newValues),
            userId: context?.onBehalfOf?.userId ?? context?.userId ?? null,
            userName: context?.onBehalfOf?.userName ?? context?.userName ?? null,
            userRole: context?.userRole ?? null,
            ip: context?.ip ?? null,
            userAgent: context?.userAgent ?? null,
            requestId: context?.requestId ?? null,
            method: context?.method ?? context?.source ?? null,
            path: context?.path ?? null,
            createdAt,
          },
        });
      });
      return;
    } catch (err) {
      const isSeqClash =
        err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
      if (isSeqClash && attempt < 2) continue;
      logger.error(`failed to write audit row for ${event.action}`, err);
      return;
    }
  }
}

/* ------------------------------------------------------------ verifying - */

export interface ChainReport {
  ok: boolean;
  checked: number;
  firstSeq: string | null;
  lastSeq: string | null;
  failures: ReturnType<typeof verifyChain>['failures'];
}

/**
 * Walk the whole chain in batches and report every break (plan item 4.3).
 *
 * Batched because the table only grows: holding the entire history in memory
 * would eventually be the thing that stops the check running, and a verifier
 * nobody can run is not evidence of anything.
 */
export async function verifyAuditChain(batchSize = 1000): Promise<ChainReport> {
  const failures: ChainReport['failures'] = [];
  let checked = 0;
  let cursor = 0n;
  let prevHash = GENESIS_HASH;
  let firstSeq: string | null = null;
  let lastSeq: string | null = null;

  for (;;) {
    const rows = (await prisma.auditLog.findMany({
      where: { seq: { gt: cursor } },
      orderBy: { seq: 'asc' },
      take: batchSize,
    })) as unknown as StoredRow[];
    if (rows.length === 0) break;

    if (firstSeq === null) firstSeq = String(rows[0].seq);
    const result = verifyChain(rows, prevHash);
    failures.push(...result.failures);
    checked += rows.length;

    const tail = rows[rows.length - 1];
    prevHash = tail.hash;
    cursor = BigInt(tail.seq);
    lastSeq = String(tail.seq);

    if (rows.length < batchSize) break;
  }

  return { ok: failures.length === 0, checked, firstSeq, lastSeq, failures };
}

/** Audit rows for one record, newest first. */
export async function auditFor(entity: string, entityId: string, take = 100) {
  return prisma.auditLog.findMany({
    where: { entity, entityId },
    orderBy: { seq: 'desc' },
    take,
  });
}

export type AuditTx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/**
 * Connect the Prisma extension to this service. Called once at boot.
 *
 * Until this runs the extension is an inert passthrough, so a maintenance
 * script that imports the client writes no audit rows - which is the right
 * default: a script run by hand is not an application action, and attributing
 * it to nobody would be noise in the trail.
 */
export function registerAuditCapture(): void {
  registerAuditHooks({
    readBefore: async (model, id) => {
      // `as any`: the delegate is chosen by name at runtime, which the static
      // client type cannot express.
      const delegate = (prisma as unknown as Record<string, { findUnique?: Function }>)[
        `${model.charAt(0).toLowerCase()}${model.slice(1)}`
      ];
      if (!delegate?.findUnique) return undefined;
      return delegate.findUnique({ where: { id } });
    },
    record: (event) =>
      recordAudit({
        action: event.action,
        entity: event.entity,
        entityId: event.entityId,
        oldValues: event.oldValues,
        newValues: event.newValues,
      }),
    onError: (message, err) => logger.error(message, err),
  });
  logger.info('audit capture registered');
}
