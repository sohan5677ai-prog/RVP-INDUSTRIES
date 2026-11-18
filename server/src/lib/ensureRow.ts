import { Prisma } from '@prisma/client';

/**
 * Create a row if it is missing, and update it only if something it cares
 * about has actually changed.
 *
 * ---------------------------------------------------------------------------
 * Why this exists rather than `upsert`
 *
 * `prisma.x.upsert({ where, update: {}, create })` reads as "create it if it
 * isn't there, otherwise leave it alone". It does not do that - when the row
 * exists Prisma issues an UPDATE anyway, and the audit extension records a
 * change that did not happen.
 *
 * Six such calls run on every server boot (two accounts, two transports, two
 * subscription plans). By 18 Nov 2026 that was 61% of the entire audit trail:
 * the same six records, rewritten on every restart, by "system", recording
 * nothing anyone did. An audit log you have to wade through is one nobody
 * reads when it matters - which is the whole asset. See
 * docs/security/PHASE-4.md.
 *
 * `upsert` with a non-empty `update` has the same problem for a different
 * reason: it writes the fields whether or not they differ.
 * ---------------------------------------------------------------------------
 */

/** The slice of a Prisma delegate this needs. Deliberately structural. */
interface RowDelegate {
  findUnique(args: { where: Record<string, unknown> }): Promise<Record<string, unknown> | null>;
  create(args: { data: Record<string, unknown> }): Promise<Record<string, unknown>>;
  update(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
}

export type EnsureOutcome = 'created' | 'updated' | 'unchanged';

/**
 * Compare a stored value with an intended one.
 *
 * Decimal and Date do not compare with `===` - a Decimal is an object, and two
 * Dates for the same instant are different objects. Getting this wrong would
 * defeat the point by reporting a change on every call.
 */
function same(stored: unknown, intended: unknown): boolean {
  if (stored === intended) return true;
  if (stored == null || intended == null) return stored == null && intended == null;
  if (Prisma.Decimal.isDecimal(stored) || Prisma.Decimal.isDecimal(intended)) {
    return new Prisma.Decimal(stored as never).equals(new Prisma.Decimal(intended as never));
  }
  if (stored instanceof Date || intended instanceof Date) {
    return new Date(stored as never).getTime() === new Date(intended as never).getTime();
  }
  return false;
}

export async function ensureRow(
  delegate: RowDelegate,
  params: {
    where: Record<string, unknown>;
    create: Record<string, unknown>;
    /**
     * Fields that must hold these values. Omit it for "create if missing, and
     * otherwise never touch it". Only the fields that actually differ are
     * written, so an unchanged row costs no write and no audit row.
     */
    keep?: Record<string, unknown>;
  }
): Promise<{ row: Record<string, unknown>; outcome: EnsureOutcome }> {
  const existing = await delegate.findUnique({ where: params.where });

  if (!existing) {
    try {
      return { row: await delegate.create({ data: params.create }), outcome: 'created' };
    } catch (err) {
      // Two boots racing, or a cron and a page load. The other one won, which
      // is the outcome we wanted; carry on with its row.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const row = await delegate.findUnique({ where: params.where });
        if (row) return { row, outcome: 'unchanged' };
      }
      throw err;
    }
  }

  if (!params.keep) return { row: existing, outcome: 'unchanged' };

  const differing = Object.fromEntries(
    Object.entries(params.keep).filter(([key, value]) => !same(existing[key], value))
  );
  if (Object.keys(differing).length === 0) {
    return { row: existing, outcome: 'unchanged' };
  }

  return {
    row: await delegate.update({ where: params.where, data: differing }),
    outcome: 'updated',
  };
}
