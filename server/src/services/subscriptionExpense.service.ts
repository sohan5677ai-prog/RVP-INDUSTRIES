import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { LedgerService } from './ledger.service.js';
import { istCalendar, istMidnight, daysInMonth } from '../lib/istDate.js';

/**
 * Recurring subscription fees (Expenses → Subscription). Nothing to do with
 * `subscription.service.ts`, which runs the SaaS licensing gate for the
 * deployment - this is an ordinary operating expense the business pays.
 *
 * Two plans run side by side and are generated, not typed in:
 *   YEARLY   ₹3,000  on 1 July every year
 *   MONTHLY  ₹2,006  on the 24th of every month, payable within 28 days
 *
 * Every charge posts a linked Payment to the "Subscription Charges" head exactly
 * like the hand-entered expense tabs, so it flows into the ledger, the P&L and the
 * husk recovery pool without any extra wiring.
 *
 * Generation is driven by `generatedThrough`, a per-plan cursor holding the charge
 * date of the last period created. Only periods after the cursor (and no later
 * than today, IST) are generated, so deleting a charge cannot resurrect it on the
 * next run - which a "does a row for this period exist?" check would.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Defaults seeded on first read. `startDate` is set to the day the plan is seeded. */
const PLAN_DEFAULTS: Record<
  'MONTHLY' | 'YEARLY',
  { amount: number; chargeDay: number; chargeMonth: number | null; dueDays: number }
> = {
  MONTHLY: { amount: 2006, chargeDay: 24, chargeMonth: null, dueDays: 28 },
  YEARLY: { amount: 3000, chargeDay: 1, chargeMonth: 7, dueDays: 0 },
};

export const SUBSCRIPTION_PLANS = ['MONTHLY', 'YEARLY'] as const;
export type PlanId = (typeof SUBSCRIPTION_PLANS)[number];

/** Midnight IST today - the last charge date a run is allowed to generate. */
function istToday(now: Date = new Date()): Date {
  const { year, month, day } = istCalendar(now);
  return istMidnight(year, month, day);
}

/**
 * Both plan configs, seeding any that don't exist yet. Seeding here (rather than
 * in a migration) keeps a fresh database and an upgraded one on the same path.
 */
export async function getSubscriptionPlans() {
  for (const plan of SUBSCRIPTION_PLANS) {
    const d = PLAN_DEFAULTS[plan];
    await prisma.subscriptionPlanConfig.upsert({
      where: { id: plan },
      update: {},
      create: {
        id: plan,
        enabled: true,
        amount: d.amount,
        chargeDay: d.chargeDay,
        chargeMonth: d.chargeMonth,
        dueDays: d.dueDays,
        // No back-dating: the first charge is the next period on or after today.
        startDate: istToday(),
      },
    });
  }
  return prisma.subscriptionPlanConfig.findMany({ orderBy: { id: 'asc' } });
}

/**
 * Charge dates a plan owes, in ascending order: every occurrence strictly after
 * `after` (the cursor, or `startDate` on the first run) and on or before `today`.
 *
 * A `chargeDay` past the end of a short month lands on that month's last day, so
 * a 31st plan still charges once in February rather than skipping it.
 */
export function dueChargeDates(
  plan: PlanId,
  cfg: { chargeDay: number; chargeMonth: number | null; startDate: Date; generatedThrough: Date | null },
  today: Date,
): { date: Date; periodKey: string }[] {
  // The cursor wins when set; otherwise start one tick before startDate so a
  // period falling exactly on startDate is still generated.
  const floor = cfg.generatedThrough ?? new Date(cfg.startDate.getTime() - 1);
  const out: { date: Date; periodKey: string }[] = [];
  const from = istCalendar(floor);
  const to = istCalendar(today);

  if (plan === 'YEARLY') {
    const month = cfg.chargeMonth ?? 7;
    for (let year = from.year; year <= to.year; year++) {
      const day = Math.min(cfg.chargeDay, daysInMonth(year, month));
      const date = istMidnight(year, month, day);
      if (date > floor && date <= today) out.push({ date, periodKey: String(year) });
    }
    return out;
  }

  // MONTHLY - walk month by month from the cursor's month to today's.
  let year = from.year;
  let month = from.month;
  for (let guard = 0; guard < 600; guard++) {
    const day = Math.min(cfg.chargeDay, daysInMonth(year, month));
    const date = istMidnight(year, month, day);
    if (date > today) break;
    if (date > floor) {
      out.push({ date, periodKey: `${year}-${String(month).padStart(2, '0')}` });
    }
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
    if (year > to.year + 1) break;
  }
  return out;
}

/**
 * Create every subscription charge that has come due since the last run.
 *
 * Called both from the daily cron and lazily on every read of the Subscription
 * tab - Render's free tier spins the server down when idle, so an in-process
 * timer alone would silently miss a charge date.
 *
 * Returns the number of charges created.
 */
export async function ensureSubscriptionCharges(now: Date = new Date()): Promise<number> {
  const plans = await getSubscriptionPlans();
  const today = istToday(now);
  let created = 0;

  for (const cfg of plans) {
    if (!cfg.enabled) continue;
    const plan = cfg.id as PlanId;
    const due = dueChargeDates(plan, cfg, today);
    if (due.length === 0) continue;

    for (const { date, periodKey } of due) {
      try {
        await prisma.$transaction(async (tx) => {
          const row = await tx.subscriptionCharge.create({
            data: {
              date,
              plan,
              periodKey,
              amount: cfg.amount,
              dueDate: new Date(date.getTime() + cfg.dueDays * DAY_MS),
              auto: true,
            },
          });
          await LedgerService.recordLinkedPayment(tx, {
            date,
            amount: Number(cfg.amount),
            type: 'SUBSCRIPTION',
            payee: plan === 'YEARLY' ? 'Yearly subscription' : 'Monthly subscription',
            description: periodKey,
            refKey: `SUBSCRIPTION-${row.id}`,
          });
          // Advance the cursor inside the same transaction: a charge and the
          // cursor that says it exists must never disagree.
          await tx.subscriptionPlanConfig.update({
            where: { id: plan },
            data: { generatedThrough: date },
          });
        });
        created++;
      } catch (e) {
        // P2002 = another run (cron vs. a page load) beat us to this period.
        // Anything else is worth knowing about but must not stop later periods.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          await prisma.subscriptionPlanConfig.update({
            where: { id: plan },
            data: { generatedThrough: date },
          });
          continue;
        }
        logger.error(`[subscription] failed to generate ${plan} ${periodKey}:`, e);
        break; // leave the cursor where it is; the next run retries this period
      }
    }
  }

  return created;
}
