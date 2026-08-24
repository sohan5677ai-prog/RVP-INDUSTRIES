import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/prisma.js', () => ({ prisma: {} }));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn() } }));

const {
  advanceSubscriptionDate,
  advanceFrom,
  nextDueDate,
  isLocked,
  daysLeft,
} = await import('./subscription.service.js');

const { istMidnight, istEndOfDay, istCalendar } = await import('../lib/istDate.js');

/** Helper to format a date to YYYY-MM-DD in IST for assertions */
function toIstDateString(date: Date): string {
  const { year, month, day } = istCalendar(date);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

describe('advanceSubscriptionDate and advanceFrom', () => {
  it('advances to next month billing day when paid early (e.g. Aug 24 when billingDay is 28)', () => {
    const now = istMidnight(2026, 8, 24); // 24 Aug 2026
    const res = advanceSubscriptionDate(null, 28, now);
    expect(toIstDateString(res)).toBe('2026-09-28');
    // Ensure timestamp is at end of day IST
    expect(res.getTime()).toBe(istEndOfDay(2026, 9, 28).getTime());
  });

  it('advances to next month billing day when paid on due date (Aug 28 with billingDay 28)', () => {
    const now = istMidnight(2026, 8, 28);
    const res = advanceSubscriptionDate(null, 28, now);
    expect(toIstDateString(res)).toBe('2026-09-28');
  });

  it('advances to next month billing day when paid late (Aug 29 with billingDay 28)', () => {
    const now = istMidnight(2026, 8, 29);
    const res = advanceSubscriptionDate(null, 28, now);
    expect(toIstDateString(res)).toBe('2026-09-28');
  });

  it('stacks 1 month onto active future paidUntil (28 Aug -> 28 Sep)', () => {
    const now = istMidnight(2026, 8, 24);
    const existingPaidUntil = istEndOfDay(2026, 8, 28); // Active paidUntil
    const res = advanceSubscriptionDate(existingPaidUntil, 28, now);
    expect(toIstDateString(res)).toBe('2026-09-28');
  });

  it('stacks multiple advance payments sequentially', () => {
    const now = istMidnight(2026, 8, 24);
    // 1st payment: gets Sep 28
    const firstPaymentEnd = advanceSubscriptionDate(null, 28, now);
    expect(toIstDateString(firstPaymentEnd)).toBe('2026-09-28');

    // 2nd payment: gets Oct 28
    const secondPaymentEnd = advanceSubscriptionDate(firstPaymentEnd, 28, now);
    expect(toIstDateString(secondPaymentEnd)).toBe('2026-10-28');

    // 3rd payment: gets Nov 28
    const thirdPaymentEnd = advanceSubscriptionDate(secondPaymentEnd, 28, now);
    expect(toIstDateString(thirdPaymentEnd)).toBe('2026-11-28');
  });

  it('rolls over year boundary cleanly (Dec -> Jan)', () => {
    const now = istMidnight(2026, 12, 15);
    const res = advanceSubscriptionDate(null, 28, now);
    expect(toIstDateString(res)).toBe('2027-01-28');
  });

  it('handles February properly for billingDay 28', () => {
    const now = istMidnight(2027, 1, 10);
    const res = advanceSubscriptionDate(null, 28, now);
    expect(toIstDateString(res)).toBe('2027-02-28');
  });

  it('clamps billing day to 1-28 range', () => {
    const now = istMidnight(2026, 8, 24);
    const resOver = advanceSubscriptionDate(null, 31, now);
    expect(toIstDateString(resOver)).toBe('2026-09-28');

    const resUnder = advanceSubscriptionDate(null, 0, now);
    expect(toIstDateString(resUnder)).toBe('2026-09-01');
  });

  it('works with advanceFrom using Subscription object', () => {
    const now = istMidnight(2026, 8, 24);
    const sub: any = {
      id: 1,
      billingDay: 28,
      paidUntil: null,
      active: true,
      servicesStopped: false,
    };
    const res = advanceFrom(sub, undefined, now);
    expect(toIstDateString(res)).toBe('2026-09-28');
  });
});

describe('isLocked and daysLeft', () => {
  it('is not locked when active and paidUntil is in future', () => {
    const sub: any = {
      active: true,
      servicesStopped: false,
      paidUntil: new Date(Date.now() + 1000000),
    };
    expect(isLocked(sub)).toBe(false);
  });

  it('is locked when active and paidUntil is in past', () => {
    const sub: any = {
      active: true,
      servicesStopped: false,
      paidUntil: new Date(Date.now() - 1000000),
    };
    expect(isLocked(sub)).toBe(true);
  });

  it('is locked when services are manually stopped even if paidUntil is in future', () => {
    const sub: any = {
      active: true,
      servicesStopped: true,
      paidUntil: new Date(Date.now() + 1000000),
    };
    expect(isLocked(sub)).toBe(true);
  });

  it('is not locked when gate is inactive (active = false)', () => {
    const sub: any = {
      active: false,
      servicesStopped: false,
      paidUntil: null,
    };
    expect(isLocked(sub)).toBe(false);
  });
});
