// Central logic for the monthly SaaS licensing gate. Reused by the
// subscription middleware (the real server-side lock) and the subscription
// routes (status / pay / developer config).
//
// The Subscription table is a singleton — there is only ever one row.
// Amounts are stored in paise (INR * 100) to match Razorpay.

import type { Subscription } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

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
 * The next occurrence of `billingDay` strictly after `from`. Day is clamped to
 * 28 so it always exists in every month (avoids Feb/30/31 edge cases). A
 * payment sets paidUntil to this, so paying always buys access through the next
 * billing day whether paid early or late.
 */
export function nextDueDate(from: Date, billingDay: number): Date {
  const day = Math.min(Math.max(Number(billingDay) || 1, 1), 28);
  const base = new Date(from);
  let due = new Date(base.getFullYear(), base.getMonth(), day, 0, 0, 0, 0);
  while (due <= base) {
    due = new Date(due.getFullYear(), due.getMonth() + 1, day, 0, 0, 0, 0);
  }
  return due;
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
    // A healthy recurring mandate is set up — the UI hides "Set up auto-pay"
    // and shows the recurring status instead. Halted/cancelled → false so the
    // button reappears.
    autopay: !!sub.razorpaySubId && HEALTHY_SUB_STATUSES.includes(sub.subStatus || ''),
  };
}

/**
 * The paid-through instant one billing cycle beyond the current one. Paying
 * early stacks onto existing access; paying late starts from now.
 */
export function advanceFrom(sub: Subscription): Date {
  const from =
    sub.paidUntil && new Date(sub.paidUntil) > new Date()
      ? new Date(sub.paidUntil)
      : new Date();
  return nextDueDate(from, sub.billingDay);
}
