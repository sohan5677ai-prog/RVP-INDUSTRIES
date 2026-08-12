import { describe, it, expect, vi } from 'vitest';

// The service pulls in Prisma and the ledger only for the write path; the date
// arithmetic under test here needs neither.
vi.mock('../lib/prisma.js', () => ({ prisma: {} }));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock('./ledger.service.js', () => ({ LedgerService: {} }));

const { dueChargeDates } = await import('./subscriptionExpense.service.js');
const { istMidnight } = await import('../lib/istDate.js');

/** The charge dates a run would produce, as YYYY-MM-DD in IST. */
function keysAndDates(
  plan: 'MONTHLY' | 'YEARLY',
  cfg: { chargeDay: number; chargeMonth?: number | null; startDate: Date; generatedThrough?: Date | null },
  today: Date,
) {
  return dueChargeDates(
    plan,
    { chargeMonth: null, generatedThrough: null, ...cfg },
    today,
  ).map((d) => `${d.periodKey}@${d.date.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })}`);
}

const AUG_11_2026 = istMidnight(2026, 8, 11);

describe('monthly subscription recurrence', () => {
  const monthly = { chargeDay: 24, startDate: AUG_11_2026 };

  it('generates nothing before the first charge day', () => {
    expect(keysAndDates('MONTHLY', monthly, istMidnight(2026, 8, 23))).toEqual([]);
  });

  it('generates the first charge on the 24th', () => {
    expect(keysAndDates('MONTHLY', monthly, istMidnight(2026, 8, 24))).toEqual(['2026-08@2026-08-24']);
  });

  it('catches up every missed month at once after a long downtime', () => {
    expect(keysAndDates('MONTHLY', monthly, istMidnight(2026, 11, 30))).toEqual([
      '2026-08@2026-08-24',
      '2026-09@2026-09-24',
      '2026-10@2026-10-24',
      '2026-11@2026-11-24',
    ]);
  });

  it('generates only what is past the cursor, and never re-generates', () => {
    const withCursor = { ...monthly, generatedThrough: istMidnight(2026, 9, 24) };
    expect(keysAndDates('MONTHLY', withCursor, istMidnight(2026, 10, 25))).toEqual(['2026-10@2026-10-24']);
    // Same run repeated on the same day - the cursor now sits on October.
    const advanced = { ...monthly, generatedThrough: istMidnight(2026, 10, 24) };
    expect(keysAndDates('MONTHLY', advanced, istMidnight(2026, 10, 25))).toEqual([]);
  });

  it('rolls a 31st charge day back to the last day of a short month', () => {
    const endOfMonth = { chargeDay: 31, startDate: istMidnight(2027, 1, 1) };
    expect(keysAndDates('MONTHLY', endOfMonth, istMidnight(2027, 3, 31))).toEqual([
      '2027-01@2027-01-31',
      '2027-02@2027-02-28',
      '2027-03@2027-03-31',
    ]);
  });

  it('crosses a year boundary', () => {
    const cfg = { ...monthly, generatedThrough: istMidnight(2026, 12, 24) };
    expect(keysAndDates('MONTHLY', cfg, istMidnight(2027, 2, 1))).toEqual([
      '2027-01@2027-01-24',
    ]);
  });
});

describe('yearly subscription recurrence', () => {
  const yearly = { chargeDay: 1, chargeMonth: 7, startDate: AUG_11_2026 };

  it('skips the renewal that already passed before the start date', () => {
    // Started 11 Aug 2026, so 1 Jul 2026 is behind us and must not be back-billed.
    expect(keysAndDates('YEARLY', yearly, istMidnight(2026, 12, 31))).toEqual([]);
  });

  it('charges on the next 1 July', () => {
    expect(keysAndDates('YEARLY', yearly, istMidnight(2027, 7, 1))).toEqual(['2027@2027-07-01']);
  });

  it('does not charge twice in the same year', () => {
    const cfg = { ...yearly, generatedThrough: istMidnight(2027, 7, 1) };
    expect(keysAndDates('YEARLY', cfg, istMidnight(2028, 6, 30))).toEqual([]);
    expect(keysAndDates('YEARLY', cfg, istMidnight(2028, 7, 1))).toEqual(['2028@2028-07-01']);
  });
});
