/**
 * Cancelling a financial document (Phase 4, plan item 4.4).
 *
 * These touch money, so the things under test are the ones that would be wrong
 * in a way nobody notices until a reconciliation: the direction of a reversing
 * entry, and whether a cancellation can happen twice.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const postJournalEntry = vi.fn();

vi.mock('../src/services/ledger.service.js', () => ({
  LedgerService: { postJournalEntry: (...a: unknown[]) => postJournalEntry(...a) },
}));

const prismaMock = {
  $transaction: vi.fn(),
  user: { findUnique: vi.fn() },
};
vi.mock('../src/lib/prisma.js', () => ({ prisma: prismaMock }));
vi.mock('../src/services/audit.service.js', () => ({ recordAudit: vi.fn() }));

const { postReversal, cancelDocumentInTx, reverseByReference, excludeCancelled } = await import(
  '../src/services/reversal.service.js'
);

/** A tx double with just the delegates these functions touch. */
function makeTx(over: Record<string, unknown> = {}) {
  return {
    journalEntry: {
      findUnique: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    account: { findMany: vi.fn().mockResolvedValue([]) },
    payment: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    receipt: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    partySetOff: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    ...over,
  } as any;
}

const ORIGINAL = {
  id: 'je1',
  reference: 'PAY-001',
  reversalOfId: null,
  lines: [
    { accountId: 'a1', debit: 1000, credit: 0, costCenter: null },
    { accountId: 'a2', debit: 0, credit: 1000, costCenter: 'RVP' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  postJournalEntry.mockResolvedValue({ id: 'je-rev' });
});

describe('postReversal', () => {
  it('swaps debits and credits rather than negating them', async () => {
    // A negative debit balances arithmetically and is wrong in every report
    // that groups by sign - this is the assertion that matters most here.
    const tx = makeTx();
    tx.journalEntry.findUnique.mockResolvedValue(ORIGINAL);
    tx.account.findMany.mockResolvedValue([
      { id: 'a1', code: '10400' },
      { id: 'a2', code: '20100' },
    ]);

    await postReversal(tx, 'je1', 'entered twice');

    const posted = postJournalEntry.mock.calls[0][1];
    expect(posted.lines).toEqual([
      { accountCode: '10400', debit: 0, credit: 1000, costCenter: undefined },
      { accountCode: '20100', debit: 1000, credit: 0, costCenter: 'RVP' },
    ]);
    for (const line of posted.lines) {
      expect(line.debit).toBeGreaterThanOrEqual(0);
      expect(line.credit).toBeGreaterThanOrEqual(0);
    }
  });

  it('dates the reversal now, not back to the original', async () => {
    // Backdating would post into a period the lock may have closed.
    const tx = makeTx();
    tx.journalEntry.findUnique.mockResolvedValue(ORIGINAL);
    const before = Date.now();
    await postReversal(tx, 'je1', 'wrong party');
    const posted = postJournalEntry.mock.calls[0][1];
    expect(posted.date.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('carries the reason into the narration', async () => {
    const tx = makeTx();
    tx.journalEntry.findUnique.mockResolvedValue(ORIGINAL);
    await postReversal(tx, 'je1', 'duplicate of PAY-000');
    expect(postJournalEntry.mock.calls[0][1].description).toContain('duplicate of PAY-000');
    expect(postJournalEntry.mock.calls[0][1].reference).toBe('REV-PAY-001');
  });

  it('links the reversal back to what it cancels', async () => {
    const tx = makeTx();
    tx.journalEntry.findUnique.mockResolvedValue(ORIGINAL);
    await postReversal(tx, 'je1', 'x');
    expect(tx.journalEntry.update).toHaveBeenCalledWith({
      where: { id: 'je-rev' },
      data: { reversalOfId: 'je1' },
    });
  });

  it('refuses to reverse a reversal', async () => {
    const tx = makeTx();
    tx.journalEntry.findUnique.mockResolvedValue({ ...ORIGINAL, reversalOfId: 'je0' });
    await expect(postReversal(tx, 'je1', 'x')).rejects.toThrow(/itself a reversal/i);
  });

  it('refuses to reverse the same entry twice', async () => {
    const tx = makeTx();
    tx.journalEntry.findUnique.mockResolvedValue(ORIGINAL);
    tx.journalEntry.findFirst.mockResolvedValue({ id: 'je-rev-existing' });
    await expect(postReversal(tx, 'je1', 'x')).rejects.toThrow(/already been reversed/i);
  });

  it('refuses when the original is gone', async () => {
    const tx = makeTx();
    tx.journalEntry.findUnique.mockResolvedValue(null);
    await expect(postReversal(tx, 'missing', 'x')).rejects.toThrow(/no longer exists/i);
  });
});

describe('cancelDocumentInTx', () => {
  const actor = { userId: 'u1', name: 'Checker' };

  it('reverses the posting and stamps the document', async () => {
    const tx = makeTx();
    tx.payment.findUnique.mockResolvedValue({ id: 'p1', journalEntryId: 'je1', cancelledAt: null });
    tx.journalEntry.findUnique.mockResolvedValue(ORIGINAL);

    await cancelDocumentInTx(tx, { model: 'payment', id: 'p1', reason: 'entered twice', actor });

    expect(postJournalEntry).toHaveBeenCalledOnce();
    const stamped = tx.payment.update.mock.calls[0][0].data;
    expect(stamped.cancelReason).toBe('entered twice');
    expect(stamped.cancelledById).toBe('u1');
    expect(stamped.cancelledAt).toBeInstanceOf(Date);
  });

  it('refuses a document that is already cancelled', async () => {
    const tx = makeTx();
    tx.payment.findUnique.mockResolvedValue({ id: 'p1', cancelledAt: new Date() });
    await expect(
      cancelDocumentInTx(tx, { model: 'payment', id: 'p1', reason: 'again', actor })
    ).rejects.toThrow(/already cancelled/i);
    expect(tx.payment.update).not.toHaveBeenCalled();
  });

  it('still stamps a document that had no posting', async () => {
    // Some rows carry no journal entry; they must still be cancellable.
    const tx = makeTx();
    tx.payment.findUnique.mockResolvedValue({ id: 'p1', journalEntryId: null, cancelledAt: null });
    await cancelDocumentInTx(tx, { model: 'payment', id: 'p1', reason: 'no posting', actor });
    expect(postJournalEntry).not.toHaveBeenCalled();
    expect(tx.payment.update).toHaveBeenCalled();
  });

  it('refuses a document that does not exist', async () => {
    const tx = makeTx();
    tx.receipt.findUnique.mockResolvedValue(null);
    await expect(
      cancelDocumentInTx(tx, { model: 'receipt', id: 'nope', reason: 'x', actor })
    ).rejects.toThrow(/not found/i);
  });
});

describe('reverseByReference', () => {
  it('reverses every matching entry and reports the count', async () => {
    // A receipt spins off TDS-<id> and SHORTAGE-<id> postings that are not
    // children of its own entry; cancelling it must take them too.
    const tx = makeTx();
    tx.journalEntry.findMany.mockResolvedValue([{ id: 'je1' }, { id: 'je2' }]);
    tx.journalEntry.findUnique.mockResolvedValue(ORIGINAL);

    expect(await reverseByReference(tx, 'TDS-d1', 'receipt cancelled')).toBe(2);
    expect(postJournalEntry).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when nothing matches', async () => {
    // Sale-Dues receipts carry no such postings.
    const tx = makeTx();
    expect(await reverseByReference(tx, 'TDS-none', 'x')).toBe(0);
    expect(postJournalEntry).not.toHaveBeenCalled();
  });

  it('skips an entry that has already been reversed', async () => {
    const tx = makeTx();
    tx.journalEntry.findMany.mockResolvedValue([{ id: 'je1' }]);
    tx.journalEntry.findFirst.mockResolvedValue({ id: 'already' });
    expect(await reverseByReference(tx, 'TDS-d1', 'x')).toBe(0);
  });
});

describe('excludeCancelled', () => {
  it('adds the guard by default and leaves it off on request', () => {
    expect(excludeCancelled({ type: 'SUPPLIER' }, false)).toEqual({
      type: 'SUPPLIER',
      cancelledAt: null,
    });
    expect(excludeCancelled({ type: 'SUPPLIER' }, true)).toEqual({ type: 'SUPPLIER' });
    expect(excludeCancelled(undefined, false)).toEqual({ cancelledAt: null });
  });
});
