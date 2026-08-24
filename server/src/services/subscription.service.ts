// Central logic for the monthly SaaS licensing gate. Reused by the
// subscription middleware (the real server-side lock) and the subscription
// routes (status / pay / developer config).
//
// The Subscription table is a singleton - there is only ever one row.
// Amounts are stored in paise (INR * 100) to match Razorpay.

import type { Subscription } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { istCalendar, istEndOfDay, daysInMonth } from '../lib/istDate.js';

/**
 * Fetch the singleton subscription row, creating it (gate OFF) if the database
 * has none yet. Safe default: active=false so a fresh install never locks
 * anyone out before it has been configured.
 */
export async function getSubscription(): Promise<Subscription> {
  let sub = await prisma.subscription.findFirst({ orderBy: { id: 'asc' } });
  if (!sub) sub = await prisma.subscription.create({ data: {} });
  return sub;
}

/**
 * The gate is engaged when either:
 *   - the developer has manually stopped services (instant kill switch, which
 *     ignores everything else), OR
 *   - the licensing gate is switched on AND the paid-through date has passed
 *     (or was never set).
 */
export function isLocked(sub: Subscription | null): boolean {
  if (!sub) return false;
  if (sub.servicesStopped) return true;
  if (!sub.active) return false;
  if (!sub.paidUntil) return true;
  return new Date() >= new Date(sub.paidUntil);
}

/**
 * The next occurrence of `billingDay` on or after `from` (end of day IST). Day is
 * clamped between 1 and 28 so it always exists in every month.
 */
export function nextDueDate(from: Date, billingDay: number): Date {
  const day = Math.min(Math.max(Number(billingDay) || 1, 1), 28);
  const cal = istCalendar(from);
  let targetYear = cal.year;
  let targetMonth = cal.month;
  if (cal.day >= day) {
    targetMonth += 1;
    if (targetMonth > 12) {
      targetMonth = 1;
      targetYear += 1;
    }
  }
  const maxDays = daysInMonth(targetYear, targetMonth);
  const targetDay = Math.min(day, maxDays);
  return istEndOfDay(targetYear, targetMonth, targetDay);
}

/**
 * Calculate the next paid-through date when advancing a subscription by 1 monthly cycle.
 *
 * Rules:
 * - If `from` (usually existing paidUntil) is active in the future (`from > now`):
 *   Advance 1 month from `from` on the configured `billingDay`.
 *   e.g. paid until 28 Aug -> new paid until 28 Sep.
 *
 * - If `from` is null or expired/today:
 *   Advance to next month's `billingDay` in IST (e.g. paying on 24 Aug with billingDay 28
 *   sets paidUntil to 28 Sep 23:59:59.999 IST, granting a full month of access).
 *
 * All paidUntil timestamps end at 23:59:59.999 IST so access is active throughout the
 * entire billing day.
 */
export function advanceSubscriptionDate(
  from: Date | null,
  billingDay: number,
  now: Date = new Date()
): Date {
  const day = Math.min(Math.max(Number(billingDay) || 1, 1), 28);

  // If existing paidUntil is in the future, advance 1 month from that existing date.
  if (from && new Date(from).getTime() > now.getTime()) {
    const cal = istCalendar(new Date(from));
    let targetYear = cal.year;
    let targetMonth = cal.month + 1;
    if (targetMonth > 12) {
      targetMonth = 1;
      targetYear += 1;
    }
    const maxDays = daysInMonth(targetYear, targetMonth);
    const targetDay = Math.min(day, maxDays);
    return istEndOfDay(targetYear, targetMonth, targetDay);
  }

  // Otherwise (expired / new subscription / paying on or before due date):
  // Paying now grants access through next month's billing day.
  const nowCal = istCalendar(now);
  let targetYear = nowCal.year;
  let targetMonth = nowCal.month + 1;
  if (targetMonth > 12) {
    targetMonth = 1;
    targetYear += 1;
  }
  const maxDays = daysInMonth(targetYear, targetMonth);
  const targetDay = Math.min(day, maxDays);
  return istEndOfDay(targetYear, targetMonth, targetDay);
}

/** Whole days remaining until paidUntil (0 if expired / unset). */
export function daysLeft(sub: Subscription | null): number {
  if (!sub || !sub.paidUntil) return 0;
  const ms = new Date(sub.paidUntil).getTime() - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / (24 * 60 * 60 * 1000));
}

const HEALTHY_SUB_STATUSES = ['created', 'authenticated', 'active', 'pending'];

/** Shape sent to the frontend. Never exposes anything sensitive. */
export function statusPayload(sub: Subscription) {
  return {
    locked: isLocked(sub),
    active: !!sub.active,
    servicesStopped: !!sub.servicesStopped,
    paidUntil: sub.paidUntil,
    daysLeft: daysLeft(sub),
    amount: sub.monthlyAmount, // paise
    billingDay: sub.billingDay,
    currency: 'INR',
    subStatus: sub.subStatus || null,
    // A healthy recurring mandate is set up - the UI hides "Set up auto-pay"
    // and shows the recurring status instead. Halted/cancelled → false so the
    // button reappears.
    autopay: !!sub.razorpaySubId && HEALTHY_SUB_STATUSES.includes(sub.subStatus || ''),
  };
}

/**
 * The paid-through instant one billing cycle beyond the current one. Paying
 * early stacks onto existing access; paying when expired starts from now.
 */
export function advanceFrom(
  sub: Subscription,
  billingDayOverride?: number,
  now: Date = new Date()
): Date {
  const billingDay = billingDayOverride ?? sub.billingDay ?? 1;
  const from =
    sub.paidUntil && new Date(sub.paidUntil).getTime() > now.getTime()
      ? new Date(sub.paidUntil)
      : null;
  return advanceSubscriptionDate(from, billingDay, now);
}
