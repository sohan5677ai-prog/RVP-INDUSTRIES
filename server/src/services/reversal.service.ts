import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { LedgerService } from './ledger.service.js';
import { recordAudit } from './audit.service.js';

/**
 * Cancelling a financial document instead of deleting it (plan item 4.4).
 *
 * The old behaviour deleted the journal entry, which took the document with it
 * and left nothing to show that money had ever been recorded as moving. A
 * cancellation keeps both: the document is marked, and a reversing entry is
 * posted so the two net to zero in the ledger.
 *
 * Why a reversing entry rather than simply excluding the original from the
 * totals: the ledger is what reconciles against the bank and against Tally,
 * and an entry that silently stops counting is a discrepancy nobody can trace.
 * A reversal is the answer an accountant expects to see, dated when the
 * decision was taken rather than backdated to the original - which is also why
 * cancelling into a closed period is refused by the period lock on the way
 * through.
 */

export interface CancelActor {
  userId: string;
  name?: string | null;
}

/**
 * Post the mirror image of an entry.
 *
 * Debits and credits are swapped line for line; the amounts are not negated.
 * A negative debit would balance arithmetically and be wrong in every report
 * that groups by sign.
 */
export async function postReversal(
  tx: Prisma.TransactionClient,
  originalEntryId: string,
  reason: string,
  at: Date = new Date()
): Promise<string> {
  const original = await tx.journalEntry.findUnique({
    where: { id: originalEntryId },
    include: { lines: true },
  });
  if (!original) throw new HttpError(404, 'The original journal entry no longer exists');
  if (original.reversalOfId) {
    throw new HttpError(400, 'That entry is itself a reversal and cannot be reversed again.');
  }

  const existing = await tx.journalEntry.findFirst({ where: { reversalOfId: originalEntryId } });
  if (existing) throw new HttpError(409, 'That entry has already been reversed.');

  const accounts = await tx.account.findMany({
    where: { id: { in: original.lines.map((l) => l.accountId) } },
    select: { id: true, code: true },
  });
  const codeById = new Map(accounts.map((a) => [a.id, a.code]));

  const entry = await LedgerService.postJournalEntry(tx, {
    // Dated now, not backdated: the reversal is a decision taken today, and
    // backdating it would reopen a period the lock has closed.
    date: at,
    reference: `REV-${original.reference}`,
    description: `Reversal of ${original.reference}: ${reason}`,
    lines: original.lines.map((l) => ({
      accountCode: codeById.get(l.accountId) ?? '',
      // Swapped, not negated.
      debit: Number(l.credit),
      credit: Number(l.debit),
      // JournalLine carries a cost centre rather than a per-line description;
      // the narrative lives on the entry.
      costCenter: l.costCenter ?? undefined,
    })),
  });

  const entryId = (entry as { id: string }).id;
  await tx.journalEntry.update({
    where: { id: entryId },
    data: { reversalOfId: originalEntryId },
  });
  return entryId;
}

/**
 * Reverse every entry posted under a reference.
 *
 * Some documents spin off postings that are not children of their own journal
 * entry - a "Mark Paid" receipt writes separate TDS-<dispatchId> and
 * SHORTAGE-<dispatchId> entries. Those were hard-deleted alongside the
 * receipt; under cancel-not-delete they have to be reversed too, or the
 * receipt would be withdrawn while its TDS stayed in the ledger and on a
 * statutory return.
 *
 * Returns how many were reversed. Zero is normal: a Sale-Dues receipt carries
 * no such postings.
 */
export async function reverseByReference(
  tx: Prisma.TransactionClient,
  reference: string,
  reason: string
): Promise<number> {
  const entries = await tx.journalEntry.findMany({
    where: { reference, reversalOfId: null },
    select: { id: true },
  });

  let reversed = 0;
  for (const entry of entries) {
    const already = await tx.journalEntry.findFirst({ where: { reversalOfId: entry.id } });
    if (already) continue;
    await postReversal(tx, entry.id, reason);
    reversed++;
  }
  return reversed;
}

type CancellableModel = 'payment' | 'receipt' | 'partySetOff';

const LABELS: Record<CancellableModel, string> = {
  payment: 'Payment',
  receipt: 'Receipt',
  partySetOff: 'Set-off',
};

/**
 * The core of a cancellation, inside a caller's transaction.
 *
 * Exposed separately because some documents need side postings reversed in the
 * same transaction - a receipt's TDS and shortage entries. Doing those in one
 * transaction and the cancellation in another would leave a window where the
 * TDS had been withdrawn but the receipt still looked live.
 */
export async function cancelDocumentInTx(
  tx: Prisma.TransactionClient,
  params: { model: CancellableModel; id: string; reason: string; actor: CancelActor }
): Promise<void> {
  const delegate = (tx as unknown as Record<string, any>)[params.model];
  const doc = await delegate.findUnique({ where: { id: params.id } });
  if (!doc) throw new HttpError(404, `${LABELS[params.model]} not found`);
  if (doc.cancelledAt) {
    throw new HttpError(409, `That ${LABELS[params.model].toLowerCase()} is already cancelled.`);
  }

  if (doc.journalEntryId) {
    await postReversal(tx, doc.journalEntryId, params.reason);
  }

  await delegate.update({
    where: { id: params.id },
    data: {
      cancelledAt: new Date(),
      cancelledById: params.actor.userId,
      cancelledByName: params.actor.name ?? null,
      cancelReason: params.reason,
    },
  });
}

/**
 * Cancel a document: reverse its posting and mark it, in one transaction.
 *
 * Either both happen or neither does. A marked document with no reversal would
 * understate what was paid; a reversal with no mark would show the document as
 * live while its money had been taken back out.
 */
export async function cancelDocument(params: {
  model: CancellableModel;
  id: string;
  reason: string;
  actor: CancelActor;
}): Promise<void> {
  const reason = params.reason.trim();
  if (reason.length < 3) {
    throw new HttpError(400, 'Give a reason for cancelling this.');
  }

  await prisma.$transaction((tx) => cancelDocumentInTx(tx, { ...params, reason }));

  // Named explicitly as well as captured by the extension: "payment.cancel" is
  // the business event, and reading it out of a generic payment.update would
  // mean knowing which column to look at.
  await recordAudit({
    action: `${params.model}.cancel`,
    entity: LABELS[params.model].replace('-', ''),
    entityId: params.id,
    newValues: { cancelReason: reason, cancelledBy: params.actor.name ?? params.actor.userId },
  });
}

/** Exclude cancelled rows unless explicitly asked for. */
export function excludeCancelled<T extends Record<string, unknown>>(
  where: T | undefined,
  includeCancelled: boolean
): T & { cancelledAt?: null } {
  const base = (where ?? {}) as T;
  return includeCancelled ? base : { ...base, cancelledAt: null };
}
