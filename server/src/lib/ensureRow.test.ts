/**
 * Seeding without writing (Phase 4 follow-up).
 *
 * The thing under test is an absence: when nothing has changed, no update is
 * issued at all. `upsert` with `update: {}` reads as if it does that and does
 * not, which is how six rows came to be rewritten on every server boot until
 * 61% of the audit trail was machine noise.
 *
 * So the assertions here are mostly `not.toHaveBeenCalled()`. That is the
 * point, not a gap.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { ensureRow } from './ensureRow.js';

function delegate(existing: Record<string, unknown> | null) {
  return {
    findUnique: vi.fn(async () => existing),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new', ...data })),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...existing, ...data })),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('when the row is missing', () => {
  it('creates it', async () => {
    const d = delegate(null);
    const { outcome } = await ensureRow(d as never, {
      where: { code: '50080' },
      create: { code: '50080', name: 'Interest Expense' },
    });
    expect(outcome).toBe('created');
    expect(d.create).toHaveBeenCalledOnce();
  });

  it('accepts a concurrent creator rather than failing the boot', async () => {
    // A cron and a page load, or two servers starting at once. The other one
    // winning is the outcome we wanted.
    const row = { code: '50080', name: 'Interest Expense' };
    const d = delegate(null);
    d.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(row);
    d.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' })
    );
    const { row: got, outcome } = await ensureRow(d as never, { where: { code: '50080' }, create: row });
    expect(outcome).toBe('unchanged');
    expect(got).toEqual(row);
  });

  it('rethrows anything that is not a duplicate', async () => {
    const d = delegate(null);
    d.create.mockRejectedValue(new Error('connection lost'));
    await expect(
      ensureRow(d as never, { where: { code: 'x' }, create: {} })
    ).rejects.toThrow(/connection lost/);
  });
});

describe('when the row exists', () => {
  it('writes nothing at all with no keep', async () => {
    // The seeded transports and subscription plans: create once, then they
    // belong to whoever edits them in the app.
    const d = delegate({ name: 'Surya Road Lines', defaultRetention: new Prisma.Decimal(3000) });
    const { outcome } = await ensureRow(d as never, {
      where: { name: 'Surya Road Lines' },
      create: { name: 'Surya Road Lines', defaultRetention: 3000 },
    });
    expect(outcome).toBe('unchanged');
    expect(d.update).not.toHaveBeenCalled();
    expect(d.create).not.toHaveBeenCalled();
  });

  it('writes nothing when every kept field already matches', async () => {
    // This is the regression: the old upsert wrote here, on every boot.
    const d = delegate({ code: '50080', name: 'Interest Expense', type: 'EXPENSE' });
    const { outcome } = await ensureRow(d as never, {
      where: { code: '50080' },
      keep: { name: 'Interest Expense', type: 'EXPENSE' },
      create: { code: '50080', name: 'Interest Expense', type: 'EXPENSE' },
    });
    expect(outcome).toBe('unchanged');
    expect(d.update).not.toHaveBeenCalled();
  });

  it('writes only the fields that differ', async () => {
    const d = delegate({ code: '50080', name: 'Interest Expenses', type: 'EXPENSE' });
    const { outcome } = await ensureRow(d as never, {
      where: { code: '50080' },
      keep: { name: 'Interest Expense', type: 'EXPENSE' },
      create: {},
    });
    expect(outcome).toBe('updated');
    // `type` matched, so it is not in the payload - an audit row should show
    // what changed, not every column that was looked at.
    expect(d.update.mock.calls[0][0].data).toEqual({ name: 'Interest Expense' });
  });

  it('does not mistake an equal Decimal for a change', async () => {
    // A Decimal is an object, so === is always false. Getting this wrong
    // would write on every call and defeat the whole point.
    const d = delegate({ defaultRetention: new Prisma.Decimal('3000.00') });
    const { outcome } = await ensureRow(d as never, {
      where: { name: 'x' },
      keep: { defaultRetention: 3000 },
      create: {},
    });
    expect(outcome).toBe('unchanged');
    expect(d.update).not.toHaveBeenCalled();
  });

  it('does not mistake an equal Date for a change', async () => {
    const d = delegate({ startDate: new Date('2026-07-01T00:00:00.000Z') });
    const { outcome } = await ensureRow(d as never, {
      where: { id: 'YEARLY' },
      keep: { startDate: new Date('2026-07-01T00:00:00.000Z') },
      create: {},
    });
    expect(outcome).toBe('unchanged');
  });

  it('still sees a real Decimal change', async () => {
    const d = delegate({ defaultRetention: new Prisma.Decimal('3000.00') });
    const { outcome } = await ensureRow(d as never, {
      where: { name: 'x' },
      keep: { defaultRetention: 2500 },
      create: {},
    });
    expect(outcome).toBe('updated');
  });

  it('treats null and undefined as the same absence, but not as equal to a value', async () => {
    const d = delegate({ notes: null });
    expect(
      (await ensureRow(d as never, { where: { id: 'x' }, keep: { notes: undefined }, create: {} })).outcome
    ).toBe('unchanged');
    expect(
      (await ensureRow(d as never, { where: { id: 'x' }, keep: { notes: 'hello' }, create: {} })).outcome
    ).toBe('updated');
  });
});
