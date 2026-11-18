import type { Prisma } from '@prisma/client';
import { HttpError } from './httpError.js';
import { logger } from './logger.js';
import { istCalendar } from './istDate.js';

/**
 * Closed accounting periods (plan item 4.5).
 *
 * Enforced at `LedgerService.postJournalEntry`, which is the only place in the
 * codebase that writes a journal entry. That is the right boundary by
 * definition: a period lock is a statement about the books, and every posting
 * - payment, receipt, purchase, sale, set-off, loan - passes through that one
 * function. Guarding the document tables instead would mean listing them, and
 * the list would go stale the first time a new document type was added.
 *
 * A lock is a date range rather than a month so a year can be closed in one
 * row, and so a partial close (up to the 15th, pending a reconciliation) is
 * expressible without inventing a second concept.
 */

/** How long a lock lookup is reused. Locks change rarely; postings are hot. */
const CACHE_TTL_MS = 60 * 1000;

interface CachedLocks {
  ranges: { from: number; to: number; reason: string | null }[];
  expiresAt: number;
}

let cache: CachedLocks | null = null;

export function invalidatePeriodLockCache(): void {
  cache = null;
}

/**
 * Load the active locks. A row with `unlockedAt` set is history, not a lock -
 * it is kept so that the fact a period was reopened survives.
 */
async function activeLocks(
  db: Prisma.TransactionClient | { periodLock: { findMany: Function } }
): Promise<CachedLocks['ranges']> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.ranges;

  const rows = await (db as { periodLock: { findMany: Function } }).periodLock.findMany({
    where: { unlockedAt: null },
    select: { fromDate: true, toDate: true, reason: true },
  });

  const ranges = (rows as { fromDate: Date; toDate: Date; reason: string | null }[]).map((r) => ({
    from: r.fromDate.getTime(),
    to: r.toDate.getTime(),
    reason: r.reason,
  }));
  cache = { ranges, expiresAt: now + CACHE_TTL_MS };
  return ranges;
}

/** The lock covering `date`, or null. */
export function lockCovering(
  ranges: CachedLocks['ranges'],
  date: Date
): CachedLocks['ranges'][number] | null {
  const t = date.getTime();
  return ranges.find((r) => t >= r.from && t <= r.to) ?? null;
}

/**
 * Refuse a posting dated inside a closed period.
 *
 * Fails **closed** on a database error, unlike the permission lookup which
 * falls back to defaults. The asymmetry is deliberate: being unable to read
 * the permission table should not lock the company out of their ERP, but being
 * unable to read the lock table must not let a posting into a closed year -
 * that is a number in a filed return. The error says so, so the operator knows
 * to retry rather than assuming the period is open.
 */
export async function assertPeriodOpen(
  db: Prisma.TransactionClient,
  date: Date,
  what = 'this entry'
): Promise<void> {
  let ranges: CachedLocks['ranges'];
  try {
    ranges = await activeLocks(db);
  } catch (err) {
    logger.error('period lock lookup failed; refusing the posting', err);
    throw new HttpError(
      503,
      'Could not check whether that accounting period is closed. Nothing has been posted - please try again.'
    );
  }

  const lock = lockCovering(ranges, date);
  if (!lock) return;

  const { day, month, year } = istCalendar(date);
  throw new HttpError(
    409,
    `${capitalise(what)} is dated ${String(day).padStart(2, '0')}-${String(month).padStart(2, '0')}-${year}, which falls in a closed period${
      lock.reason ? ` (${lock.reason})` : ''
    }. Reopen the period first, or date it after the close.`
  );
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Does a proposed lock overlap one already in force? */
export function overlaps(
  ranges: CachedLocks['ranges'],
  from: Date,
  to: Date
): boolean {
  const f = from.getTime();
  const t = to.getTime();
  return ranges.some((r) => f <= r.to && t >= r.from);
}
