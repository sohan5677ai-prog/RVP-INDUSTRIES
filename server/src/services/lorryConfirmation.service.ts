import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

/**
 * The lorry-booking register fed by the transporter's WhatsApp messages.
 *
 * A message arrives before the lorry does ("18/7 Punganur To Surat 30 Tonnes
 * AP39T8217 Driver Moula 7207012803 Rs 75000"), so the row sits WAITING until a
 * dispatch is raised on that lorry number. It is deliberately read-only towards
 * the rest of the ERP: it never rewrites a dispatch's freight, only supplies the
 * driver details the office would otherwise re-type, and records that the
 * booking has been used.
 */

/** States that mean "booked, nothing shipped on it yet". DRAFT is the legacy name. */
export const WAITING_STATES = ['WAITING', 'DRAFT'] as const;
/** States that mean "a dispatch went out on this booking". CONFIRMED is the legacy name. */
export const USED_STATES = ['CONFIRMED', 'USED'] as const;

/**
 * Lorry numbers are written every way imaginable - "AP39T8217", "AP 39 T 8217",
 * "ap-39-t-8217". Matching only works if both sides are reduced to the same
 * thing, so everything is stored and compared in this form.
 */
export function normalizeLorryNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return cleaned.length >= 4 ? cleaned : null;
}

/**
 * The booking a dispatch on `lorryNumber` should draw its driver from: the most
 * recent waiting row for that lorry.
 *
 * Newest-first matters because the same lorry runs the route repeatedly - an old
 * row that was never marked used must not hand a stale driver to today's trip.
 */
export async function findWaitingConfirmation(lorryNumber: string | null | undefined) {
  const key = normalizeLorryNumber(lorryNumber);
  if (!key) return null;
  return prisma.transportConfirmation.findFirst({
    where: { lorryNumber: key, status: { in: [...WAITING_STATES] } },
    orderBy: [{ messageDate: 'desc' }, { createdAt: 'desc' }],
  });
}

/**
 * Close the loop when a lorry actually goes out: flip its waiting booking to
 * USED and point it at the dispatch.
 *
 * Never throws - a dispatch that has already been written to the ledger must not
 * fail because a WhatsApp bookkeeping row could not be updated. Returns the id
 * of the row that was marked, or null when there was no booking to match (the
 * normal case for a lorry the transporter never messaged about).
 */
export async function markConfirmationUsed(
  lorryNumber: string | null | undefined,
  saleDispatchId: string,
): Promise<string | null> {
  try {
    const row = await findWaitingConfirmation(lorryNumber);
    if (!row) return null;
    await prisma.transportConfirmation.update({
      where: { id: row.id },
      data: { status: 'USED', saleDispatchId },
    });
    logger.info(`[lorry-register] booking ${row.id} (${row.lorryNumber}) used by dispatch ${saleDispatchId}`);
    return row.id;
  } catch (err) {
    logger.error(`[lorry-register] could not mark a booking used for dispatch ${saleDispatchId}`, err);
    return null;
  }
}

/**
 * Undoing a dispatch puts its booking back on the waiting list - the lorry was
 * still booked, only the shipment was a mistake, so the next dispatch on that
 * number should find the driver again.
 */
export async function releaseConfirmationForDispatch(saleDispatchId: string): Promise<void> {
  try {
    await prisma.transportConfirmation.updateMany({
      where: { saleDispatchId, status: { in: [...USED_STATES] } },
      data: { status: 'WAITING', saleDispatchId: null },
    });
  } catch (err) {
    logger.error(`[lorry-register] could not release the booking for dispatch ${saleDispatchId}`, err);
  }
}
