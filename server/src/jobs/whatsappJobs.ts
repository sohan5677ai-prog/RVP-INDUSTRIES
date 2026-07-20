import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { whatsappService } from '../services/whatsapp.service.js';
import { computeBuyerDues, invoiceListText, topPendingText } from '../services/salesDues.service.js';

/**
 * Scheduled WhatsApp jobs (use cases 7, 8, 9, 10). Runs in-process via node-cron
 * in Asia/Kolkata time. Every job is also callable on demand (see runDailyJobs /
 * runWeeklyJobs, exposed as secret-guarded endpoints) so it can be triggered
 * manually or by an external cron — a useful fallback since Render free-tier
 * spins down when idle and an in-process timer can miss its window.
 *
 * Idempotency: each owner digest is keyed by day/week in WhatsAppLog, and buyer
 * dues reminders are throttled, so a restart or a double-trigger never spams.
 */

const TZ = 'Asia/Kolkata';
const DUES_THROTTLE_MS = 48 * 60 * 60 * 1000; // don't re-nag a buyer within 48h

/** YYYY-MM-DD in IST for the given instant (used for idempotency keys). */
function istDayKey(d: Date = new Date()): string {
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

/** dd-MMM for a compact human range in the weekly summary. */
function fmtShort(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: TZ });
}

// ---------------------------------------------------------------------------
// #10 — Owner daily outstanding-dues digest
// ---------------------------------------------------------------------------
async function runOwnerDuesDigest() {
  const dayKey = istDayKey();
  if (await whatsappService.lastSentAt('OWNER_DUES_DIGEST', dayKey)) return; // already sent today
  const portfolio = await computeBuyerDues();
  await whatsappService.sendOwnerDuesDigest(
    {
      asOn: new Date(),
      totalReceivable: portfolio.totalReceivable,
      overdue: portfolio.totalOverdue,
      topPending: topPendingText(portfolio.topPending),
    },
    dayKey
  );
}

// ---------------------------------------------------------------------------
// #7 — Buyer sales-dues reminders (only overdue buyers, throttled)
// ---------------------------------------------------------------------------
async function runBuyerDuesReminders() {
  const portfolio = await computeBuyerDues();
  for (const buyer of portfolio.buyers) {
    if (buyer.overdueInvoices.length === 0 || !buyer.phone) continue;
    const last = await whatsappService.lastSentAt('PAYMENT_REMINDER', buyer.buyerId);
    if (last && Date.now() - last.getTime() < DUES_THROTTLE_MS) continue; // throttled
    await whatsappService.sendSalesDuesReminder(
      { id: buyer.buyerId, name: buyer.name, phone: buyer.phone },
      buyer.overdueOutstanding,
      invoiceListText(buyer.overdueInvoices)
    );
  }
}

// ---------------------------------------------------------------------------
// #8 — Owner deferred-dispatch reminders
// ---------------------------------------------------------------------------
async function runDeferredDispatchReminders() {
  const todayKey = istDayKey();
  const orders = await prisma.saleOrder.findMany({
    where: { reminderDate: { not: null }, status: { in: ['PENDING', 'PARTIAL'] } },
    include: { buyer: { select: { name: true } } },
  });
  for (const order of orders) {
    if (!order.reminderDate) continue;
    if (istDayKey(order.reminderDate) > todayKey) continue; // reminder date not reached yet
    const last = await whatsappService.lastSentAt('OWNER_DISPATCH_REMINDER', order.id);
    if (last && istDayKey(last) === todayKey) continue; // already reminded today
    const summary = `${order.product} · ${(order.tonnageKg / 1000).toFixed(2)} MT`;
    await whatsappService.notifyOwnerDispatch({
      id: order.id,
      buyerName: order.buyer.name,
      orderSummary: summary,
      dispatchBy: order.reminderDate,
      ref: `SO-${order.id.slice(-6)}`,
    });
  }
}

// ---------------------------------------------------------------------------
// #9 — Owner weekly summary
// ---------------------------------------------------------------------------
async function runWeeklySummary() {
  const start = daysAgo(7);
  const weekKey = istDayKey(start);
  if (await whatsappService.lastSentAt('OWNER_WEEKLY_SUMMARY', weekKey)) return;
  const [seedLoads, saleOrders, huskOrders] = await Promise.all([
    prisma.stockIn.count({ where: { arrivalDate: { gte: start } } }),
    prisma.saleOrder.count({ where: { saleDate: { gte: start } } }),
    prisma.saleOrder.count({ where: { saleDate: { gte: start }, product: 'HUSK' } }),
  ]);
  const range = `${fmtShort(start)} – ${fmtShort(new Date())}`;
  await whatsappService.sendOwnerWeeklySummary(range, { seedLoads, saleOrders, huskOrders }, weekKey);
}

// ---------------------------------------------------------------------------
// Aggregators (also the endpoint targets)
// ---------------------------------------------------------------------------

/** All daily jobs: owner dues digest (#10) + buyer dues reminders (#7) + deferred-dispatch reminders (#8). */
export async function runDailyJobs() {
  const results: Record<string, string> = {};
  for (const [name, fn] of [
    ['ownerDuesDigest', runOwnerDuesDigest],
    ['buyerDuesReminders', runBuyerDuesReminders],
    ['deferredDispatchReminders', runDeferredDispatchReminders],
  ] as const) {
    try {
      await fn();
      results[name] = 'ok';
    } catch (e) {
      results[name] = e instanceof Error ? e.message : String(e);
      logger.error(`[whatsapp-cron] ${name} failed`, e);
    }
  }
  return results;
}

/** Weekly summary (#9). */
export async function runWeeklyJobs() {
  try {
    await runWeeklySummary();
    return { weeklySummary: 'ok' };
  } catch (e) {
    logger.error('[whatsapp-cron] weeklySummary failed', e);
    return { weeklySummary: e instanceof Error ? e.message : String(e) };
  }
}

/** Just the deferred-dispatch reminders (#8) — exposed separately for testing. */
export async function runDispatchReminderJob() {
  try {
    await runDeferredDispatchReminders();
    return { deferredDispatchReminders: 'ok' };
  } catch (e) {
    logger.error('[whatsapp-cron] deferredDispatchReminders failed', e);
    return { deferredDispatchReminders: e instanceof Error ? e.message : String(e) };
  }
}

/** Map a job name (from the manual endpoint) to its runner. */
export const JOB_RUNNERS: Record<string, () => Promise<Record<string, string>>> = {
  daily: runDailyJobs,
  weekly: runWeeklyJobs,
  'dispatch-reminders': runDispatchReminderJob,
};

/**
 * Register the in-process cron schedules. Called once at server start, gated by
 * WHATSAPP_CRON_ENABLED so it stays off until you're ready.
 */
export function registerWhatsappCron() {
  if (process.env.WHATSAPP_CRON_ENABLED !== 'true') {
    logger.info('[whatsapp-cron] disabled (set WHATSAPP_CRON_ENABLED=true to enable)');
    return;
  }
  // Daily at 09:00 IST — dues digest, buyer reminders, deferred-dispatch reminders.
  cron.schedule('0 9 * * *', () => { void runDailyJobs(); }, { timezone: TZ });
  // Weekly on Monday at 08:00 IST — owner business summary.
  cron.schedule('0 8 * * 1', () => { void runWeeklyJobs(); }, { timezone: TZ });
  logger.info('[whatsapp-cron] scheduled (daily 09:00, weekly Mon 08:00, IST)');
}
