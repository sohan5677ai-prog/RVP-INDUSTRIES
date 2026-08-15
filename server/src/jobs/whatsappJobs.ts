import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { whatsappService, type OwnerWeeklyStats, type ProductWeekStats } from '../services/whatsapp.service.js';
import { computeBuyerDues, invoiceListText, topPendingText, dueTodayListText } from '../services/salesDues.service.js';
import { computeSupplierDues } from '../services/purchaseDues.service.js';
import { computeProfitLossSummary } from '../controllers/ledger.controller.js';
import { renderSalesDuesReportPdf } from '../lib/salesDuesPdf.js';
import { getCompanyProfileRow } from '../controllers/settings.controller.js';
import { uploadFileToStorage } from '../lib/upload.js';

/**
 * Scheduled WhatsApp jobs (use cases 7-12). Runs in-process via node-cron in
 * Asia/Kolkata time. Every job is also callable on demand: the CRON_SECRET
 * fallback endpoint (`/webhooks/whatsapp/jobs/:job`, for an external cron
 * when Render's free tier is asleep) and the authenticated Settings "Send
 * Now" button (`OWNER_DIGEST_JOBS`, `JobOpts.force`) both go through
 * `JOB_RUNNERS`.
 *
 * Each of the five owner digests (see `OWNER_DIGEST_JOBS` below) also has an
 * on/off toggle on `CompanyProfile`, editable in Settings -> WhatsApp. The
 * cron and the CRON_SECRET fallback both respect it (via `ownerJobEnabled`);
 * only an explicit "Send Now" click (`force: true`) bypasses it.
 *
 * Idempotency: each owner digest is keyed by day/week in WhatsAppLog, and buyer
 * dues reminders are throttled, so a restart or a double-trigger never spams.
 * "Send Now" (`force: true`) deliberately bypasses this too, so a manual click
 * always actually sends even if the automatic run already fired today.
 */

const TZ = 'Asia/Kolkata';
const DUES_THROTTLE_MS = 48 * 60 * 60 * 1000; // don't re-nag a buyer within 48h

/** YYYY-MM-DD in IST for the given instant (used for idempotency keys). */
function istDayKey(d: Date = new Date()): string {
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

/** IST is a fixed +05:30 offset with no DST, so the shift is a constant. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Identity of the week `d` falls in: the YYYY-MM-DD of that week's Monday, IST.
 *
 * The weekly summary used to key off "today minus 7 days", which is a different
 * value every day - so any manual /jobs/weekly trigger on a day other than the
 * Monday the cron fired sent a second summary for the same week. Anchoring to
 * the week's Monday makes every trigger inside one week resolve to one key.
 */
function istWeekKey(d: Date = new Date()): string {
  const ist = new Date(d.getTime() + IST_OFFSET_MS); // UTC fields now read as IST
  const daysSinceMonday = (ist.getUTCDay() + 6) % 7; // Mon -> 0 ... Sun -> 6
  const monday = new Date(ist.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000);
  return monday.toISOString().slice(0, 10);
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

/**
 * Turn a send result into something the manual endpoint can report. A bare "ok"
 * hid the common failure - the job ran, decided to send, and Fast2SMS refused
 * or the template id was unset - behind the same word as a real delivery.
 */
function describeSend(res: { ok: boolean; skipped?: boolean; error?: string }, what: string): string {
  if (res.ok) return `sent (${what})`;
  return `${res.skipped ? 'skipped' : 'failed'} (${what}): ${res.error ?? 'unknown reason'}`;
}

/**
 * Options every owner job runner accepts. `force` is set only by the
 * authenticated "Send Now" button in Settings - it skips both the
 * Settings on/off toggle and the "already sent today/this week" dedupe, so a
 * deliberate manual click always actually sends. The in-process cron and the
 * CRON_SECRET fallback endpoint never pass this, so the automatic schedule
 * always respects both.
 */
interface JobOpts {
  force?: boolean;
}

/** True when `field` is on in Settings, or `opts.force` bypasses the check entirely. */
async function ownerJobEnabled(opts: JobOpts, field: 'ownerDuesDigestEnabled' | 'ownerDueTodayDigestEnabled' | 'ownerBusinessSnapshotEnabled' | 'ownerWeeklySummaryEnabled' | 'ownerDispatchReminderEnabled'): Promise<boolean> {
  if (opts.force) return true;
  const profile = await getCompanyProfileRow();
  return profile[field];
}

// ---------------------------------------------------------------------------
// #10 - Owner daily outstanding-dues digest
// ---------------------------------------------------------------------------
async function runOwnerDuesDigest(opts: JobOpts = {}): Promise<string> {
  if (!(await ownerJobEnabled(opts, 'ownerDuesDigestEnabled'))) return 'disabled in Settings';
  const dayKey = istDayKey();
  if (!opts.force && (await whatsappService.lastSentAt('OWNER_DUES_DIGEST', dayKey))) return `already sent for ${dayKey}`;
  const portfolio = await computeBuyerDues();

  // Best-effort: the digest still sends as text-only if the PDF can't be built
  // (storage hiccup, missing company profile row) - a report failure must
  // never suppress the daily figures the owners actually rely on.
  let document: { url: string; filename: string } | undefined;
  try {
    const profile = await getCompanyProfileRow();
    const buffer = await renderSalesDuesReportPdf(
      {
        name: profile.name,
        address: profile.address,
        gstin: profile.gstin,
        contact: profile.contact,
        stateName: profile.stateName,
        stateCode: profile.stateCode,
        pincode: profile.pincode,
      },
      portfolio,
    );
    const filename = `Outstanding-Sales-Dues-${dayKey}.pdf`;
    const url = await uploadFileToStorage({ originalname: filename, mimetype: 'application/pdf', buffer } as Express.Multer.File);
    document = { url, filename };
  } catch (e) {
    logger.error('[whatsapp] outstanding sales dues PDF failed', e);
  }

  const res = await whatsappService.sendOwnerDuesDigest(
    {
      asOn: new Date(),
      totalReceivable: portfolio.totalReceivable,
      overdue: portfolio.totalOverdue,
      topPending: topPendingText(portfolio.topPending),
    },
    dayKey,
    document,
  );
  return describeSend(res, dayKey);
}

// ---------------------------------------------------------------------------
// #11 - Owner "bills due today" digest, 06:00 IST. Deliberately silent on a
// day with nothing due - see the skip below - unlike runOwnerDuesDigest above,
// which always sends (even a "no overdue dues" summary).
// ---------------------------------------------------------------------------
async function runOwnerDueTodayDigest(opts: JobOpts = {}): Promise<string> {
  if (!(await ownerJobEnabled(opts, 'ownerDueTodayDigestEnabled'))) return 'disabled in Settings';
  const dayKey = istDayKey();
  if (!opts.force && (await whatsappService.lastSentAt('OWNER_DUE_TODAY_DIGEST', dayKey))) return `already sent for ${dayKey}`;
  const portfolio = await computeBuyerDues();
  if (portfolio.dueToday.length === 0) return `no bills due today (${dayKey}) - nothing sent`;
  const res = await whatsappService.sendOwnerDueTodayDigest(
    {
      asOn: new Date(),
      totalDueToday: portfolio.totalDueToday,
      count: portfolio.dueToday.length,
      listText: dueTodayListText(portfolio.dueToday),
    },
    dayKey
  );
  return describeSend(res, dayKey);
}

// ---------------------------------------------------------------------------
// #12 - Owner daily business snapshot (receivables, overdue receivables,
// payables, overdue invoices pending, net profit), 06:00 IST alongside the
// due-today digest. Always sends, like runOwnerDuesDigest - an owner wants
// this even on a day with nothing new. Data-only body, no greeting, no
// sign-off - see docs/whatsapp-owner-business-snapshot-template.md for why.
// ---------------------------------------------------------------------------
async function runOwnerBusinessSnapshot(opts: JobOpts = {}): Promise<string> {
  if (!(await ownerJobEnabled(opts, 'ownerBusinessSnapshotEnabled'))) return 'disabled in Settings';
  const dayKey = istDayKey();
  if (!opts.force && (await whatsappService.lastSentAt('OWNER_BUSINESS_SNAPSHOT', dayKey))) return `already sent for ${dayKey}`;
  const [portfolio, supplierDues, pnl] = await Promise.all([
    computeBuyerDues(),
    computeSupplierDues(),
    computeProfitLossSummary(),
  ]);
  // "Pending clearance" means overdue - past due date and still uncollected -
  // not every unsettled invoice (a bill not yet due isn't something to chase).
  const overduePendingInvoices = portfolio.buyers.reduce((n, b) => n + b.overdueInvoices.length, 0);
  const res = await whatsappService.sendOwnerBusinessSnapshot(
    {
      asOn: new Date(),
      totalReceivable: portfolio.totalReceivable,
      overdueReceivable: portfolio.totalOverdue,
      totalPayable: supplierDues.totalPayable,
      pendingInvoices: overduePendingInvoices,
      netProfit: pnl.totals.netProfit,
    },
    dayKey
  );
  return describeSend(res, dayKey);
}

// ---------------------------------------------------------------------------
// #7 - Buyer sales-dues reminders (only overdue buyers, throttled)
// ---------------------------------------------------------------------------
async function runBuyerDuesReminders(): Promise<string> {
  const portfolio = await computeBuyerDues();
  let sent = 0;
  let failed = 0;
  let throttled = 0;
  let lastError: string | undefined;
  for (const buyer of portfolio.buyers) {
    if (buyer.overdueInvoices.length === 0 || (!buyer.phone && !buyer.phone2)) continue;
    const last = await whatsappService.lastSentAt('PAYMENT_REMINDER', buyer.buyerId);
    if (last && Date.now() - last.getTime() < DUES_THROTTLE_MS) {
      throttled += 1;
      continue;
    }
    const res = await whatsappService.sendSalesDuesReminder(
      { id: buyer.buyerId, name: buyer.name, phone: buyer.phone, phone2: buyer.phone2, waLanguage: buyer.waLanguage },
      buyer.overdueOutstanding,
      invoiceListText(buyer.overdueInvoices)
    );
    if (res.ok) sent += 1;
    else {
      failed += 1;
      lastError = res.error;
    }
  }
  return `sent ${sent}, failed ${failed}, throttled ${throttled}${lastError ? ` - last error: ${lastError}` : ''}`;
}

// ---------------------------------------------------------------------------
// #8 - Owner deferred-dispatch reminders
// ---------------------------------------------------------------------------
async function runDeferredDispatchReminders(opts: JobOpts = {}): Promise<string> {
  if (!(await ownerJobEnabled(opts, 'ownerDispatchReminderEnabled'))) return 'disabled in Settings';
  const todayKey = istDayKey();
  let sent = 0;
  let failed = 0;
  let lastError: string | undefined;
  // Include dispatches due today, overdue, or due within 2 days
  const twoDaysAhead = new Date();
  twoDaysAhead.setDate(twoDaysAhead.getDate() + 2);
  const maxDayKey = istDayKey(twoDaysAhead);

  const orders = await prisma.saleOrder.findMany({
    where: { status: { in: ['PENDING', 'PARTIAL'] } },
    include: { buyer: { select: { name: true } }, dispatches: { select: { weightKg: true } } },
  });

  for (const order of orders) {
    const effectiveDate = order.reminderDate ?? order.saleDate;
    if (!effectiveDate) continue;

    // Only alert if dispatch target/sale date is due within 2 days or past due
    if (istDayKey(effectiveDate) > maxDayKey) continue;

    const last = await whatsappService.lastSentAt('OWNER_DISPATCH_REMINDER', order.id);
    if (!opts.force && last && istDayKey(last) === todayKey) continue; // already reminded today

    const dispatchedKg = order.dispatches.reduce((acc: number, d: { weightKg: number }) => acc + (d.weightKg || 0), 0);
    const remainingKg = Math.max(0, order.tonnageKg - dispatchedKg);
    const remainingTonnes = (remainingKg > 0 ? remainingKg : order.tonnageKg) / 1000;
    const summary = `${order.product} · ${remainingTonnes.toFixed(2)}`;

    const res = await whatsappService.notifyOwnerDispatch({
      id: order.id,
      buyerName: order.buyer.name,
      orderSummary: summary,
      dispatchBy: effectiveDate,
      ref: `SO-${order.id.slice(-6)}`,
    });
    if (res.ok) sent += 1;
    else {
      failed += 1;
      lastError = res.error;
    }
  }
  return `sent ${sent}, failed ${failed}${lastError ? ` - last error: ${lastError}` : ''}`;
}

// ---------------------------------------------------------------------------
// #9 - Owner weekly summary
// ---------------------------------------------------------------------------
/** kg -> plain 2dp MT number. The "MT" itself lives in the template text. */
function toMt(kg: number): string {
  return (kg / 1000).toFixed(2);
}

/**
 * One product's week: intake, what shipped during the week, and the standing
 * balance still owed to buyers.
 *
 * `pendingMt` deliberately spans ALL open orders, not just the week's - an order
 * taken three weeks ago and still undelivered is exactly what the owner needs to
 * see on a Monday. It mirrors `remainingKg` in sale.controller.ts: a short-closed
 * order (closedAt set) has no balance left however the arithmetic reads, so those
 * are excluded rather than left showing a permanent few-hundred-kg tail.
 */
async function productWeekStats(product: 'PAPPU' | 'HUSK', start: Date): Promise<ProductWeekStats> {
  const [taken, dispatched, openOrders] = await Promise.all([
    prisma.saleOrder.aggregate({
      where: { product, saleDate: { gte: start } },
      _count: { _all: true },
      _sum: { tonnageKg: true },
    }),
    prisma.saleDispatch.aggregate({
      where: { dispatchDate: { gte: start }, saleOrder: { product } },
      _sum: { weightKg: true },
    }),
    prisma.saleOrder.findMany({
      where: { product, closedAt: null, status: { in: ['PENDING', 'PARTIAL'] } },
      select: { tonnageKg: true, dispatches: { select: { weightKg: true } } },
    }),
  ]);

  const pendingKg = openOrders.reduce((sum, o) => {
    const shipped = o.dispatches.reduce((s, d) => s + d.weightKg, 0);
    return sum + Math.max(0, o.tonnageKg - shipped);
  }, 0);

  return {
    orders: taken._count._all,
    orderedMt: toMt(taken._sum.tonnageKg ?? 0),
    dispatchedMt: toMt(dispatched._sum.weightKg ?? 0),
    pendingMt: toMt(pendingKg),
  };
}

/** Everything the weekly template prints. */
async function collectWeeklyStats(start: Date): Promise<OwnerWeeklyStats> {
  const [ordered, arrivedLorries, pendingPOs, pappu, husk] = await Promise.all([
    // Lorries ordered this week. KNM_BATCH POs are synthetic rows minted at
    // stock-in for cold-storage batches - a movement, not a fresh purchase - so
    // counting them here would report seed we never ordered.
    prisma.purchaseOrder.findMany({
      where: { poDate: { gte: start }, status: { not: 'CANCELLED' }, createdBy: { not: 'KNM_BATCH' } },
      select: { lorryCount: true },
    }),
    prisma.stockIn.count({ where: { arrivalDate: { gte: start } } }),
    // Still to arrive, live. Same definition as the Party Ledger's pending-loads
    // reminder (loadPendingLoads), so the two never disagree.
    prisma.purchaseOrder.findMany({
      where: { status: 'PENDING' },
      select: { lorryCount: true, _count: { select: { stockIns: true } } },
    }),
    productWeekStats('PAPPU', start),
    productWeekStats('HUSK', start),
  ]);

  return {
    seed: {
      orderedLorries: ordered.reduce((s, po) => s + (po.lorryCount || 1), 0),
      arrivedLorries,
      pendingLorries: pendingPOs.reduce((s, po) => s + Math.max(0, (po.lorryCount || 1) - po._count.stockIns), 0),
    },
    pappu,
    husk,
  };
}

async function runWeeklySummary(opts: JobOpts = {}): Promise<string> {
  if (!(await ownerJobEnabled(opts, 'ownerWeeklySummaryEnabled'))) return 'disabled in Settings';
  const start = daysAgo(7);
  // Keyed by the week, not by the run date, so a manual trigger later in the
  // same week is a no-op rather than a duplicate summary.
  const weekKey = istWeekKey();
  if (!opts.force && (await whatsappService.lastSentAt('OWNER_WEEKLY_SUMMARY', weekKey))) {
    return `already sent for week of ${weekKey}`;
  }
  const stats = await collectWeeklyStats(start);
  const range = `${fmtShort(start)} – ${fmtShort(new Date())}`;
  const res = await whatsappService.sendOwnerWeeklySummary(range, stats, weekKey);
  return describeSend(res, `week of ${weekKey}`);
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
      results[name] = await fn();
    } catch (e) {
      results[name] = e instanceof Error ? e.message : String(e);
      logger.error(`[whatsapp-cron] ${name} failed`, e);
    }
  }
  return results;
}

/** Just the owner dues digest (#10) - exposed separately from runDailyJobs so Settings' "Send Now" can fire it alone. */
export async function runDuesDigestJob(opts: JobOpts = {}) {
  try {
    return { ownerDuesDigest: await runOwnerDuesDigest(opts) };
  } catch (e) {
    logger.error('[whatsapp-cron] ownerDuesDigest failed', e);
    return { ownerDuesDigest: e instanceof Error ? e.message : String(e) };
  }
}

/** Weekly summary (#9). */
export async function runWeeklyJobs(opts: JobOpts = {}) {
  try {
    return { weeklySummary: await runWeeklySummary(opts) };
  } catch (e) {
    logger.error('[whatsapp-cron] weeklySummary failed', e);
    return { weeklySummary: e instanceof Error ? e.message : String(e) };
  }
}

/** Just the owner "due today" digest (#11) - exposed separately since it runs on its own 06:00 schedule, not inside runDailyJobs. */
export async function runDueTodayJob(opts: JobOpts = {}) {
  try {
    return { ownerDueTodayDigest: await runOwnerDueTodayDigest(opts) };
  } catch (e) {
    logger.error('[whatsapp-cron] ownerDueTodayDigest failed', e);
    return { ownerDueTodayDigest: e instanceof Error ? e.message : String(e) };
  }
}

/** Just the owner business snapshot (#12) - exposed separately since it runs on its own 06:00 schedule, not inside runDailyJobs. */
export async function runBusinessSnapshotJob(opts: JobOpts = {}) {
  try {
    return { ownerBusinessSnapshot: await runOwnerBusinessSnapshot(opts) };
  } catch (e) {
    logger.error('[whatsapp-cron] ownerBusinessSnapshot failed', e);
    return { ownerBusinessSnapshot: e instanceof Error ? e.message : String(e) };
  }
}

/** Just the deferred-dispatch reminders (#8) - exposed separately for testing. */
export async function runDispatchReminderJob(opts: JobOpts = {}) {
  try {
    return { deferredDispatchReminders: await runDeferredDispatchReminders(opts) };
  } catch (e) {
    logger.error('[whatsapp-cron] deferredDispatchReminders failed', e);
    return { deferredDispatchReminders: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Diagnostic - which phone_number_id actually owns the DISPATCH_DRIVER
// template, vs. what FAST2SMS_PHONE_NUMBER_ID is currently set to. Fast2SMS's
// Meta-format send (sendLocationWhatsAppTemplate) 404s with "Template not
// found." when those two disagree. No Render shell access needed - this rides
// the same secret-guarded /webhooks/whatsapp/jobs/:job endpoint as the other
// cron jobs, so it's reachable from a plain browser URL.
// ---------------------------------------------------------------------------
async function runCheckDriverTemplate(): Promise<Record<string, unknown>> {
  const apiKey = process.env.FAST2SMS_API_KEY;
  if (!apiKey) return { error: 'FAST2SMS_API_KEY is not configured' };
  const configuredId = process.env.FAST2SMS_PHONE_NUMBER_ID ?? null;
  const templateName = process.env.FAST2SMS_TMPL_NAME_DISPATCH_DRIVER?.trim() || 'driver_industries';

  const res = await fetch('https://www.fast2sms.com/dev/dlt_manager/whatsapp?type=template', {
    headers: { Authorization: apiKey },
  });
  const text = await res.text();
  if (!res.ok) return { error: `HTTP ${res.status}`, body: text.slice(0, 2000) };

  let parsed: { data?: Array<{ phone_number_id: string; number: string; templates?: Array<{ template_name: string; status: string; language: string }> }> };
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'Non-JSON response', body: text.slice(0, 2000) };
  }

  const numbers = (parsed.data ?? []).map((entry) => ({
    number: entry.number,
    phoneNumberId: entry.phone_number_id,
    isConfigured: entry.phone_number_id === configuredId,
    templates: (entry.templates ?? []).map((t) => ({
      name: t.template_name,
      status: t.status,
      language: t.language,
      isMatch: t.template_name === templateName,
    })),
  }));

  const owner = numbers.find((n) => n.templates.some((t) => t.isMatch));
  const verdict = !owner
    ? `No number has a template named "${templateName}" - check the exact approved name.`
    : owner.isConfigured
      ? `OK: FAST2SMS_PHONE_NUMBER_ID already owns "${templateName}". The mismatch is elsewhere.`
      : `MISMATCH: "${templateName}" is approved under phone_number_id ${owner.phoneNumberId} (number ${owner.number}), ` +
        `but FAST2SMS_PHONE_NUMBER_ID is set to ${configuredId ?? '(not set)'}. Update the Render env var to ${owner.phoneNumberId}.`;

  return { configuredPhoneNumberId: configuredId, templateName, numbers, verdict };
}

// ---------------------------------------------------------------------------
// Diagnostic - the whole template picture: every template Fast2SMS has approved
// (raw, so whatever field carries the numeric message_id is visible) next to the
// FAST2SMS_TMPL_* vars actually set on this deployment. A template whose id is
// unset sends nothing and logs SKIPPED "…is not configured"; an id that belongs
// to another number (or is a Meta id rather than a Fast2SMS one) logs FAILED
// with "message_id is invalid or not approved". This tells the two apart.
// ---------------------------------------------------------------------------
async function runCheckTemplates(): Promise<Record<string, unknown>> {
  const apiKey = process.env.FAST2SMS_API_KEY;
  if (!apiKey) return { error: 'FAST2SMS_API_KEY is not configured' };
  const configuredId = process.env.FAST2SMS_PHONE_NUMBER_ID ?? null;

  const configuredEnv = Object.fromEntries(
    Object.entries(process.env)
      .filter(([k]) => k.startsWith('FAST2SMS_TMPL_'))
      .map(([k, v]) => [k, v?.trim() || '(empty)'])
  );

  const res = await fetch('https://www.fast2sms.com/dev/dlt_manager/whatsapp?type=template', {
    headers: { Authorization: apiKey },
  });
  const text = await res.text();
  if (!res.ok) return { error: `HTTP ${res.status}`, body: text.slice(0, 2000), configuredEnv };

  let parsed: { data?: Array<{ phone_number_id?: string; number?: string; templates?: unknown[] }> };
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'Non-JSON response', body: text.slice(0, 2000), configuredEnv };
  }

  return {
    configuredPhoneNumberId: configuredId,
    configuredEnv,
    numbers: (parsed.data ?? []).map((entry) => ({
      number: entry.number,
      phoneNumberId: entry.phone_number_id,
      isConfigured: entry.phone_number_id === configuredId,
      templates: entry.templates ?? [], // raw - id field name varies by panel version
    })),
  };
}

/** Map a job name (from the manual endpoint) to its runner. */
export const JOB_RUNNERS: Record<string, (opts?: JobOpts) => Promise<Record<string, unknown>>> = {
  daily: runDailyJobs,
  weekly: runWeeklyJobs,
  'dispatch-reminders': runDispatchReminderJob,
  'due-today': runDueTodayJob,
  'business-snapshot': runBusinessSnapshotJob,
  'dues-digest': runDuesDigestJob,
  'check-driver-template': runCheckDriverTemplate,
  'check-templates': runCheckTemplates,
};

/**
 * The owner-facing scheduled digests, in the order Settings shows them - the
 * single source of truth for both the on/off toggle (`enabledField`, a
 * CompanyProfile column) and the "Send Now" button (`jobKey`, a JOB_RUNNERS
 * entry) in the Settings WhatsApp tab. Buyer dues reminders (#7) are
 * deliberately excluded - those go to buyers, not the owners.
 */
export interface OwnerDigestJobMeta {
  jobKey: string;
  label: string;
  schedule: string;
  templateName: string;
  /** WhatsAppLog.relatedType, for the "last sent" lookup. */
  relatedType: string;
  enabledField:
    | 'ownerDuesDigestEnabled'
    | 'ownerDueTodayDigestEnabled'
    | 'ownerBusinessSnapshotEnabled'
    | 'ownerWeeklySummaryEnabled'
    | 'ownerDispatchReminderEnabled';
}

export const OWNER_DIGEST_JOBS: OwnerDigestJobMeta[] = [
  {
    jobKey: 'due-today',
    label: 'Bills Due Today',
    schedule: '06:00 IST, every day',
    templateName: 'due_today',
    relatedType: 'OWNER_DUE_TODAY_DIGEST',
    enabledField: 'ownerDueTodayDigestEnabled',
  },
  {
    jobKey: 'business-snapshot',
    label: 'Daily Business Snapshot',
    schedule: '06:00 IST, every day',
    templateName: 'rvpdaily',
    relatedType: 'OWNER_BUSINESS_SNAPSHOT',
    enabledField: 'ownerBusinessSnapshotEnabled',
  },
  {
    jobKey: 'dues-digest',
    label: 'Daily Dues Digest',
    schedule: '09:00 IST, every day',
    templateName: 'rvp_owner_dues',
    relatedType: 'OWNER_DUES_DIGEST',
    enabledField: 'ownerDuesDigestEnabled',
  },
  {
    jobKey: 'dispatch-reminders',
    label: 'Deferred Dispatch Reminders',
    schedule: '09:00 IST, every day (only sent when an advance order is overdue to ship)',
    templateName: 'rvp_owner_dispatch',
    relatedType: 'OWNER_DISPATCH_REMINDER',
    enabledField: 'ownerDispatchReminderEnabled',
  },
  {
    jobKey: 'weekly',
    label: 'Weekly Business Summary',
    schedule: '08:00 IST, every Monday',
    templateName: 'rvp_owner_weekly',
    relatedType: 'OWNER_WEEKLY_SUMMARY',
    enabledField: 'ownerWeeklySummaryEnabled',
  },
];

/**
 * Register the in-process cron schedules. Called once at server start, gated by
 * WHATSAPP_CRON_ENABLED so it stays off until you're ready.
 */
export function registerWhatsappCron() {
  if (process.env.WHATSAPP_CRON_ENABLED !== 'true') {
    logger.info('[whatsapp-cron] disabled (set WHATSAPP_CRON_ENABLED=true to enable)');
    return;
  }
  // Daily at 06:00 IST - owner "bills due today" digest + business snapshot.
  // Both are meant to greet the owners before the business day starts, ahead
  // of the 09:00 bundle below.
  cron.schedule('0 6 * * *', () => { void runDueTodayJob(); }, { timezone: TZ });
  cron.schedule('0 6 * * *', () => { void runBusinessSnapshotJob(); }, { timezone: TZ });
  // Daily at 09:00 IST - dues digest, buyer reminders, deferred-dispatch reminders.
  cron.schedule('0 9 * * *', () => { void runDailyJobs(); }, { timezone: TZ });
  // Weekly on Monday at 08:00 IST - owner business summary.
  cron.schedule('0 8 * * 1', () => { void runWeeklyJobs(); }, { timezone: TZ });
  logger.info('[whatsapp-cron] scheduled (due-today + business-snapshot 06:00, daily 09:00, weekly Mon 08:00, IST)');
}
