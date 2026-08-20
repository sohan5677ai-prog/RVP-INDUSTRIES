import type { Request, Response } from 'express';
import type { WaLanguage } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { logger } from '../lib/logger.js';
import { whatsappService, normalizeWhatsAppNumber } from '../services/whatsapp.service.js';
import { parseTransportConfirmationText } from '../lib/gemini.js';
import { sendDispatchBundleWhatsApp, resendDispatchDriverWhatsApp } from '../services/dispatchWhatsapp.service.js';
import {
  normalizeLorryNumber,
  findWaitingConfirmation,
  WAITING_STATES,
  USED_STATES,
} from '../services/lorryConfirmation.service.js';
import { JOB_RUNNERS, OWNER_DIGEST_JOBS, describeCron, buildCron, rescheduleOwnerJob } from '../jobs/whatsappJobs.js';
import { buildPartyStatementData } from './ledger.controller.js';
import { getCompanyProfileRow } from './settings.controller.js';
import { renderStatementPdf } from '../lib/statementPdf.js';
import { renderBrokerLedgerPdf } from '../lib/brokerLedgerPdf.js';
import { buildBrokerLedgerData, isOwnBroker } from '../services/brokerLedger.service.js';
import { uploadFileToStorage } from '../lib/upload.js';
import { computePartyDues, invoiceListText } from '../services/salesDues.service.js';
import { duesScope, runPartyPaymentReminderCore } from '../services/partyReminder.service.js';

// ---------------------------------------------------------------------------
// Inbound webhook (public - Fast2SMS calls this, no JWT)
// ---------------------------------------------------------------------------

/** URL validation: some panels probe with GET; Meta-style probes send hub.challenge. */
export async function verifyWhatsAppWebhook(req: Request, res: Response) {
  const challenge = req.query['hub.challenge'];
  if (typeof challenge === 'string') {
    res.send(challenge);
    return;
  }
  res.send('OK');
}

/**
 * Pull the sender + message text out of a Fast2SMS webhook payload. The exact
 * shape isn't publicly documented, so probe the field names BSP payloads
 * commonly use; the raw body is always logged so the real shape can be
 * confirmed from WhatsAppLog after the first live event.
 */
function extractInbound(body: unknown): { from: string | null; text: string | null } {
  if (!body || typeof body !== 'object') return { from: null, text: null };
  const b = body as Record<string, unknown>;
  const containers = [b, b.data, b.message, b.payload].filter(
    (x): x is Record<string, unknown> => !!x && typeof x === 'object'
  );
  let from: string | null = null;
  let text: string | null = null;
  for (const c of containers) {
    for (const key of ['from', 'sender', 'mobile', 'number', 'wa_id', 'phone', 'from_number']) {
      const v = c[key];
      if (!from && (typeof v === 'string' || typeof v === 'number') && String(v).replace(/\D/g, '').length >= 10) {
        from = String(v);
      }
    }
    for (const key of ['text', 'message', 'body', 'msg', 'content', 'message_body']) {
      const v = c[key];
      if (!text && typeof v === 'string' && v.trim()) text = v.trim();
      // Meta-style nested { text: { body: "..." } }
      if (!text && v && typeof v === 'object' && typeof (v as Record<string, unknown>).body === 'string') {
        text = ((v as Record<string, unknown>).body as string).trim();
      }
    }
  }
  return { from, text };
}

/** Fast2SMS's `message_id` (a Meta `wamid.…`), used to drop retried deliveries. */
function extractMessageId(body: unknown): string | null {
  const r = asRecord(body);
  if (!r) return null;
  for (const key of ['message_id', 'messageId', 'request_id', 'requestId']) {
    const v = r[key];
    if ((typeof v === 'string' || typeof v === 'number') && String(v).trim()) return String(v).trim();
  }
  return null;
}

/**
 * Persist an inbound message. Runs BEFORE the webhook is acknowledged, so a
 * restart between the ACK and this write can't lose a transporter's message.
 *
 * Returns null when the payload is a retry we've already filed. Throws on a
 * database failure - the caller turns that into a non-2xx so Fast2SMS retries
 * rather than dropping the message on the floor.
 */
async function recordInboundMessage(rawBody: unknown): Promise<{ id: string; from: string | null; text: string | null } | null> {
  const { from, text } = extractInbound(rawBody);
  const body = text ?? JSON.stringify(rawBody).slice(0, 4000);

  // Fast2SMS retries a webhook up to 3 times, 60s apart, whenever our response
  // wasn't a 2xx - so the same message can legitimately arrive more than once.
  // Without this, one retried transporter message becomes two DRAFT rows, and
  // confirming both would apply the freight twice.
  //
  // The body has to match too. A retry repeats the payload verbatim, so an
  // identical body is the signature of one; matching on the id ALONE would mean
  // that if Fast2SMS ever sends a per-webhook `request_id` rather than a
  // per-message `wamid`, every message after the first is discarded forever.
  const messageId = extractMessageId(rawBody);
  if (messageId) {
    const seen = await prisma.whatsAppLog.findFirst({
      where: { direction: 'INBOUND', providerId: messageId, body },
      select: { id: true },
    });
    if (seen) {
      logger.info(`[whatsapp] duplicate inbound ${messageId} ignored (log ${seen.id})`);
      return null;
    }
  }

  const logRow = await prisma.whatsAppLog.create({
    data: { direction: 'INBOUND', phone: from, body, status: 'RECEIVED', providerId: messageId },
  });
  return { id: logRow.id, from, text };
}

/**
 * File a booked lorry into the register. Runs after the ACK: it's the slow half
 * (a Gemini round-trip), and unlike the write above it is safely repeatable -
 * the raw text is already in WhatsAppLog, so a message lost here can be
 * re-parsed from the log rather than being gone.
 *
 * The row lands WAITING and stays there until a dispatch is raised on the same
 * lorry number. Nothing existing is touched: a booking message is news about a
 * lorry that is yet to load, not a correction to a trip already made.
 */
async function parseInboundIntoRegister(logRow: { id: string; from: string | null; text: string | null }) {
  const { from, text } = logRow;

  // A transport confirmation is a long-ish text with digits (lorry no / phone).
  if (!text || text.length < 25 || !/\d{4}/.test(text)) return;

  const parsed = await parseTransportConfirmationText(text);
  if (!parsed?.isTransportConfirmation) return;
  if (!parsed.lorryNumber && !parsed.driverPhone) return; // nothing actionable

  const booking = await prisma.transportConfirmation.create({
    data: {
      fromPhone: from ?? 'unknown',
      rawText: text,
      messageDate: parsed.messageDate ? new Date(parsed.messageDate) : null,
      fromPlace: parsed.fromPlace ?? null,
      toPlace: parsed.toPlace ?? null,
      tonnageKg: parsed.tonnageKg ?? null,
      // Normalised on the way in - the dispatch screen looks the row up by lorry
      // number, and that only works if both sides are spelled the same way.
      lorryNumber: normalizeLorryNumber(parsed.lorryNumber),
      driverName: parsed.driverName ?? null,
      driverPhone: parsed.driverPhone ?? null,
      freightAmount: parsed.freightAmount ?? null,
      status: 'WAITING',
    },
  });
  logger.info(`[whatsapp] lorry booking ${booking.id} (${booking.lorryNumber ?? 'no lorry no'}) filed from ${from} (log ${logRow.id})`);
}

// ---------------------------------------------------------------------------
// Delivery-status callbacks
// ---------------------------------------------------------------------------

/**
 * A send is logged SENT the moment Fast2SMS's HTTP call returns OK - that only
 * means Fast2SMS *accepted* the request. Whether WhatsApp actually delivered it
 * is reported later, on this webhook. Without handling it, a message that Meta
 * rejects (unapproved/paused template, undeliverable number) sits in the log as
 * a green "sent" forever, which is how the driver leg failed silently.
 */
type StatusEvent = { providerId: string | null; phone: string | null; status: string; error: string | null };

/** Terminal states that mean the recipient did NOT get the message. */
const DELIVERY_FAILED = new Set(['failed', 'undelivered', 'rejected', 'error']);
/** States that mean it's still on track - nothing to record beyond the existing SENT. */
const DELIVERY_OK = new Set(['sent', 'accepted', 'delivered', 'read']);

function asRecord(x: unknown): Record<string, unknown> | null {
  return x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

/** Flatten Meta's `errors: [{ code, title, error_data: { details } }]` into one line. */
function describeErrors(errs: unknown[]): string | null {
  const parts = errs.map((e) => {
    const r = asRecord(e);
    if (!r) return String(e);
    const details = asRecord(r.error_data)?.details;
    return [r.code, r.title ?? r.message, typeof details === 'string' ? details : null]
      .filter(Boolean)
      .join(' - ');
  });
  return parts.filter(Boolean).join(' | ') || null;
}

/** Read one status object, whichever field names the payload happens to use. */
function readStatusEntry(raw: Record<string, unknown>): StatusEvent | null {
  const status = typeof raw.status === 'string' ? raw.status.toLowerCase().trim() : null;
  if (!status) return null;

  let error: string | null = null;
  if (Array.isArray(raw.errors) && raw.errors.length > 0) {
    error = describeErrors(raw.errors);
  } else {
    // Deliberately NOT probing `message` here - on flat payloads it's the message
    // body as often as it is the failure reason.
    for (const key of ['error', 'error_message', 'reason', 'failure_reason', 'description']) {
      const v = raw[key];
      if (!error && typeof v === 'string' && v.trim()) error = v.trim();
    }
  }

  let providerId: string | null = null;
  for (const key of ['request_id', 'requestId', 'message_id', 'messageId', 'id']) {
    const v = raw[key];
    if (!providerId && (typeof v === 'string' || typeof v === 'number') && String(v).trim()) {
      providerId = String(v).trim();
    }
  }

  let phone: string | null = null;
  for (const key of ['recipient_id', 'mobile', 'number', 'numbers', 'to', 'phone', 'wa_id']) {
    const v = raw[key];
    if (!phone && (typeof v === 'string' || typeof v === 'number') && String(v).replace(/\D/g, '').length >= 10) {
      phone = String(v);
    }
  }

  return { providerId, phone, status, error };
}

/**
 * Pull status events out of a webhook payload. Like `extractInbound`, the exact
 * Fast2SMS shape isn't documented - some accounts get Meta's envelope forwarded
 * verbatim, others a flattened object - so probe both.
 */
function extractStatusEvents(body: unknown): StatusEvent[] {
  const root = asRecord(body);
  if (!root) return [];
  const out: StatusEvent[] = [];
  const push = (x: unknown) => {
    const r = asRecord(x);
    const ev = r && readStatusEntry(r);
    if (ev) out.push(ev);
  };

  // Meta envelope: entry[].changes[].value.statuses[]
  if (Array.isArray(root.entry)) {
    for (const entry of root.entry) {
      const changes = asRecord(entry)?.changes;
      if (!Array.isArray(changes)) continue;
      for (const change of changes) {
        const statuses = asRecord(asRecord(change)?.value)?.statuses;
        if (Array.isArray(statuses)) statuses.forEach(push);
      }
    }
  }
  if (out.length > 0) return out;

  // Flattened: { statuses: [...] }, { data: {...} }, or the body itself.
  for (const container of [root, asRecord(root.data), asRecord(root.payload)]) {
    if (!container) continue;
    if (Array.isArray(container.statuses)) container.statuses.forEach(push);
    else push(container);
    if (out.length > 0) break;
  }
  return out;
}

/**
 * Find the log row a status event refers to. Fast2SMS returns its own
 * `request_id` at send time while Meta's callback carries a `wamid`, so the id
 * often won't match - fall back to the most recent still-SENT outbound message
 * to that number.
 */
async function findLogRowForStatus(ev: StatusEvent) {
  if (ev.providerId) {
    const byId = await prisma.whatsAppLog.findFirst({
      where: { direction: 'OUTBOUND', providerId: ev.providerId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, template: true, phone: true },
    });
    if (byId) return byId;
  }
  const phone = normalizeWhatsAppNumber(ev.phone);
  if (!phone) return null;
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  return prisma.whatsAppLog.findFirst({
    where: { direction: 'OUTBOUND', phone, status: 'SENT', createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, template: true, phone: true },
  });
}

/** Record a delivery failure against the originating log row. Never throws. */
async function applyStatusEvent(ev: StatusEvent) {
  if (!DELIVERY_FAILED.has(ev.status)) {
    // 'delivered'/'read' would be worth storing, but WaStatus has no state for
    // them and adding one means a schema change; SENT already covers the happy path.
    if (!DELIVERY_OK.has(ev.status)) logger.warn(`[whatsapp] unrecognised delivery status "${ev.status}"`);
    return;
  }
  const row = await findLogRowForStatus(ev);
  const reason = `Delivery failed (${ev.status})${ev.error ? `: ${ev.error}` : ''}`;
  if (!row) {
    logger.warn(`[whatsapp] ${reason} - no matching log row (id=${ev.providerId}, phone=${ev.phone})`);
    return;
  }
  await prisma.whatsAppLog.update({
    where: { id: row.id },
    data: { status: 'FAILED', errorMessage: reason },
  });
  logger.error(`[whatsapp] ${row.template ?? 'message'} to ${row.phone} - ${reason}`);
}

/** A delivery receipt we know how to interpret. "received" is NOT one - it means inbound. */
function isKnownDeliveryStatus(status: string): boolean {
  return DELIVERY_OK.has(status) || DELIVERY_FAILED.has(status);
}

type WebhookRoute =
  | { kind: 'inbound' }
  | { kind: 'status'; events: StatusEvent[] }
  | { kind: 'ignored'; reason: string };

/**
 * Decide what a payload IS. Pure and I/O-free, so the handler can route before
 * it commits to any database work.
 *
 * Status callbacks and inbound messages arrive on the same endpoint. Fast2SMS
 * labels which is which in `webhook_type` (`incoming_message` vs
 * `status_update`), so that field is trusted above everything else. It matters
 * because a webhook registered for `event: "all"` renders ONE payload template
 * for both kinds, so an inbound message can arrive carrying a `status` field.
 *
 * The rule for unlabelled payloads is therefore "a sender plus message text
 * means inbound, WHATEVER the status field says". An earlier version special-
 * cased only `status: "received"`, which left every other word Fast2SMS might
 * stamp on an inbound message ("success", "queued", ...) falling through to the
 * delivery-receipt path, where it matched neither DELIVERY_OK nor
 * DELIVERY_FAILED and the message was dropped with nothing written anywhere.
 * Being over-eager here is cheap; being under-eager loses a lorry's freight.
 */
function routeWebhookEvent(rawBody: unknown): WebhookRoute {
  const declaredRaw = asRecord(rawBody)?.webhook_type;
  const declared = typeof declaredRaw === 'string' ? declaredRaw.toLowerCase().trim() : null;

  if (declared === 'incoming_message') return { kind: 'inbound' };

  if (declared === 'status_update') {
    const events = extractStatusEvents(rawBody);
    // Don't hand a delivery receipt to Gemini as if it were a transporter's
    // message - but do say what arrived, so an unknown shape is diagnosable.
    return events.length > 0
      ? { kind: 'status', events }
      : { kind: 'ignored', reason: 'status_update with no readable status entry' };
  }

  // Unlabelled from here down.
  const { from, text } = extractInbound(rawBody);
  if (from && text) return { kind: 'inbound' };

  const events = extractStatusEvents(rawBody);
  if (events.some((e) => isKnownDeliveryStatus(e.status))) return { kind: 'status', events };

  // Neither clearly a message nor a receipt we recognise. File it as inbound
  // anyway: recordInboundMessage stores the raw payload, so the worst case is a
  // stray WhatsAppLog row to look at rather than an event that vanished.
  return { kind: 'inbound' };
}

/**
 * Fast2SMS event receiver.
 *
 * The URL is public (Fast2SMS can't send a JWT), so when
 * FAST2SMS_WEBHOOK_SECRET is set we require it back on every call - otherwise
 * anyone who learns the URL can post fabricated transporter messages and get
 * freight drafts queued for confirmation. Unset = accept everything, so an
 * un-configured deploy keeps working.
 *
 * Inbound messages are WRITTEN BEFORE THE ACK. Once we return 2xx, Fast2SMS
 * considers the event delivered and never retries it, so anything still only in
 * memory at that point is lost for good if the instance is recycled - which on
 * a sleeping/redeploying host is exactly when it happens. Persisting first costs
 * one insert and makes the retry protocol work for us: if the database is
 * unreachable we answer 503 and Fast2SMS brings the message back.
 */
export async function handleWhatsAppWebhook(req: Request, res: Response) {
  const secret = process.env.FAST2SMS_WEBHOOK_SECRET?.trim();
  if (secret) {
    const provided = req.header('webhook_secret_key') || req.header('x-webhook-secret');
    if (provided?.trim() !== secret) {
      logger.warn('[whatsapp] webhook rejected - bad or missing webhook_secret_key');
      // 401, not 200: a wrong secret is a real misconfiguration, and Fast2SMS
      // retrying makes it visible rather than silently dropping every event.
      res.status(401).json({ error: 'Invalid webhook secret' });
      return;
    }
  }

  const route = routeWebhookEvent(req.body);

  if (route.kind === 'ignored') {
    logger.warn(`[whatsapp] ${route.reason}: ${JSON.stringify(req.body).slice(0, 500)}`);
    res.json({ received: true });
    return;
  }

  if (route.kind === 'inbound') {
    let logRow: Awaited<ReturnType<typeof recordInboundMessage>>;
    try {
      logRow = await recordInboundMessage(req.body);
    } catch (err) {
      logger.error('[whatsapp] could not record inbound message - asking Fast2SMS to retry', err);
      res.status(503).json({ error: 'Could not record message' });
      return;
    }
    res.json({ received: true });
    // Duplicate (null) needs no further work; otherwise parse in the background,
    // where a failure costs a register row but never the message itself.
    if (logRow) {
      parseInboundIntoRegister(logRow).catch((err) => {
        logger.error(`[whatsapp] booking parse failed for log ${logRow.id}`, err);
      });
    }
    return;
  }

  // Delivery receipts only annotate an existing row, so there is nothing to lose
  // by acknowledging first.
  res.json({ received: true });
  Promise.all(route.events.map(applyStatusEvent)).catch((err) => {
    logger.error('[whatsapp] status processing failed', err);
  });
}

/**
 * Run a scheduled WhatsApp job on demand (public, secret-guarded - so an external
 * cron can drive it despite Render's free-tier spin-down). Job name in the path:
 * `daily`, `weekly` or `dispatch-reminders`. Auth via CRON_SECRET (X-Cron-Secret
 * header or ?secret= query).
 */
export async function runWhatsAppJob(req: Request, res: Response) {
  const secret = process.env.CRON_SECRET;
  const provided = req.header('x-cron-secret') || (typeof req.query.secret === 'string' ? req.query.secret : undefined);
  if (!secret || provided !== secret) throw new HttpError(401, 'Invalid or missing cron secret');
  const runner = JOB_RUNNERS[req.params.job];
  if (!runner) throw new HttpError(404, `Unknown job "${req.params.job}"`);
  const result = await runner();
  res.json({ job: req.params.job, result });
}

// ---------------------------------------------------------------------------
// Authenticated endpoints
// ---------------------------------------------------------------------------

/**
 * The 5 owner-facing scheduled digests, for the Settings -> WhatsApp
 * "Owner Daily Messages" panel: each row's on/off state (from CompanyProfile)
 * and when it last actually sent (from WhatsAppLog), so the toggle and the
 * "Send Now" button both have something to show.
 */
export async function listOwnerWhatsAppJobs(_req: Request, res: Response) {
  const profile = await getCompanyProfileRow();
  const rows = await Promise.all(
    OWNER_DIGEST_JOBS.map(async (job) => {
      const last = await prisma.whatsAppLog.findFirst({
        where: { relatedType: job.relatedType, status: 'SENT' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      const cronExpr = (profile[job.cronField] as string | null) || job.defaultCron;
      return {
        jobKey: job.jobKey,
        label: job.label,
        cron: cronExpr,
        schedule: describeCron(cronExpr) + (job.note ? ` (${job.note})` : ''),
        templateName: job.templateName,
        enabled: profile[job.enabledField],
        lastSentAt: last?.createdAt ?? null,
      };
    })
  );
  res.json(rows);
}

/**
 * Save one owner digest's schedule (time + days) and apply it to the live
 * cron immediately - see rescheduleOwnerJob in whatsappJobs.ts. Body is
 * `{ hour: 0-23, minute: 0-59, days: number[] }` (0=Sun..6=Sat); an empty or
 * 7-day `days` means "every day". Restricted to the 5 OWNER_DIGEST_JOBS keys,
 * same as the "Send Now" endpoint above.
 */
export async function updateOwnerWhatsAppJobSchedule(req: Request, res: Response) {
  const job = OWNER_DIGEST_JOBS.find((j) => j.jobKey === req.params.job);
  if (!job) throw new HttpError(404, `Unknown owner job "${req.params.job}"`);

  const { hour, minute, days } = req.body as { hour?: unknown; minute?: unknown; days?: unknown };
  if (!Number.isInteger(hour) || (hour as number) < 0 || (hour as number) > 23) {
    throw new HttpError(400, 'hour must be an integer 0-23');
  }
  if (!Number.isInteger(minute) || (minute as number) < 0 || (minute as number) > 59) {
    throw new HttpError(400, 'minute must be an integer 0-59');
  }
  if (!Array.isArray(days) || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
    throw new HttpError(400, 'days must be an array of integers 0-6');
  }

  const cronExpr = buildCron(hour as number, minute as number, days as number[]);
  await getCompanyProfileRow(); // ensure the row exists
  await prisma.companyProfile.update({
    where: { id: 'default' },
    data: { [job.cronField]: cronExpr },
  });
  await rescheduleOwnerJob(job.jobKey);
  res.json({ jobKey: job.jobKey, cron: cronExpr, schedule: describeCron(cronExpr) + (job.note ? ` (${job.note})` : '') });
}

/**
 * "Send Now" - fires one owner digest immediately, bypassing both its
 * Settings on/off toggle and the "already sent today/this week" dedupe (see
 * `JobOpts.force` in whatsappJobs.ts). Restricted to the 5 keys in
 * OWNER_DIGEST_JOBS, not every JOB_RUNNERS entry - the UI must not be able to
 * trigger the bundled `daily` job or the Fast2SMS diagnostics this way.
 */
export async function runOwnerWhatsAppJobNow(req: Request, res: Response) {
  const job = OWNER_DIGEST_JOBS.find((j) => j.jobKey === req.params.job);
  if (!job) throw new HttpError(404, `Unknown owner job "${req.params.job}"`);
  const result = await JOB_RUNNERS[job.jobKey]({ force: true });
  res.json({ job: job.jobKey, result });
}

export async function listWhatsAppLogs(req: Request, res: Response) {
  const take = Math.min(Number(req.query.take) || 50, 200);
  const logs = await prisma.whatsAppLog.findMany({
    orderBy: { createdAt: 'desc' },
    take,
  });
  res.json(logs);
}

const REMINDER_THROTTLE_MS = 4 * 60 * 60 * 1000; // 4h - a double-click must not spam the party

/**
 * The word "lorry"/"lorries" as it appears INSIDE the reminder's breakdown
 * variable, per language.
 *
 * Everything else in that message is fixed template text that Meta holds in the
 * approved translation, but the breakdown is built here - so without this a
 * Telugu supplier would read a Telugu message wrapped around an English list.
 * Singular first, plural second.
 */
const LORRY_WORDS: Record<WaLanguage, [string, string]> = {
  EN: ['lorry', 'lorries'],
  TE: ['లారీ', 'లారీలు'],
  TA: ['லாரி', 'லாரிகள்'],
  KN: ['ಲಾರಿ', 'ಲಾರಿಗಳು'],
  HI: ['लॉरी', 'लॉरी'],
};

/**
 * The lorries still to arrive against a party's PENDING POs, with the priced
 * per-PO breakdown the reminder template prints. Shared by the send endpoint and
 * the context endpoint that decides whether the button is shown at all.
 *
 * `language` is the party's, so the ledger's preview shows the same string that
 * lands on their phone rather than an English stand-in.
 */
async function loadPendingLoads(partyId: string, language: WaLanguage = 'EN') {
  const pendingPOs = await prisma.purchaseOrder.findMany({
    where: { partyId, status: 'PENDING' },
    include: { stockIns: { select: { id: true } } },
    orderBy: { poDate: 'asc' },
  });
  const pos = pendingPOs
    .map((po) => ({
      poNumber: po.poNumber,
      pricePerKg: Number(po.pricePerKg),
      remaining: Math.max(0, (po.lorryCount || 1) - po.stockIns.length),
    }))
    .filter((p) => p.remaining > 0);
  const lorries = pos.reduce((s, p) => s + p.remaining, 0);
  // Priced per-PO breakdown, price → lorries → (PO), e.g.
  // "• ₹95/kg - 3 lorries (RVP/01)\n• ₹96/kg - 2 lorries (RVP/02)".
  const [one, many] = LORRY_WORDS[language] ?? LORRY_WORDS.EN;
  const breakdown = pos
    .map((p) => `• ₹${p.pricePerKg}/kg - ${p.remaining} ${p.remaining === 1 ? one : many} (${p.poNumber ?? '-'})`)
    .join('\n');
  return { lorries, breakdown, pos };
}

/**
 * "Remind about pending loads" button on the Party Ledger: counts the lorries
 * still to arrive across the party's PENDING POs and sends rvp_reminder.
 */
export async function sendPartyReminder(req: Request, res: Response) {
  const party = await prisma.party.findUnique({ where: { id: req.params.partyId } });
  if (!party) throw new HttpError(404, 'Party not found');
  if (!party.phone && !party.phone2) throw new HttpError(400, `${party.name} has no phone number on file - add one in Parties first`);

  const lastAt = await whatsappService.lastReminderAt(party.id);
  if (lastAt && Date.now() - lastAt.getTime() < REMINDER_THROTTLE_MS) {
    const mins = Math.ceil((REMINDER_THROTTLE_MS - (Date.now() - lastAt.getTime())) / 60000);
    throw new HttpError(429, `A reminder was already sent recently. Try again in ~${mins} min.`);
  }

  const pending = await loadPendingLoads(party.id, party.waLanguage);
  if (pending.lorries === 0) {
    throw new HttpError(400, 'No pending lorries against this party - nothing to remind about');
  }

  const result = await whatsappService.sendReminder(
    { id: party.id, name: party.name, phone: party.phone, phone2: party.phone2, waLanguage: party.waLanguage },
    pending.lorries,
    pending.breakdown
  );
  if (!result.ok) throw new HttpError(502, result.error ?? 'WhatsApp send failed');
  res.json({ ok: true, pendingLorries: pending.lorries, breakdown: pending.breakdown });
}

// --- Party Ledger reminder buttons ------------------------------------------

/**
 * What the Party Ledger's two reminder buttons may do for this party. Both are
 * conditional: pending loads only when POs are still to arrive, the payment
 * reminder only when sale invoices are actually outstanding - so the page never
 * offers a send that the server would refuse.
 */
export async function getPartyReminderContext(req: Request, res: Response) {
  const party = await prisma.party.findUnique({
    where: { id: req.params.partyId },
    select: { id: true, name: true, phone: true, phone2: true, waLanguage: true },
  });
  if (!party) throw new HttpError(404, 'Party not found');

  const [pending, dues] = await Promise.all([
    loadPendingLoads(party.id, party.waLanguage),
    computePartyDues(party.id),
  ]);

  const active = dues ? duesScope(dues) : null;
  const brokerName = new Map(dues?.brokers.map((b) => [b.id, b.name]) ?? []);

  res.json({
    party,
    pending: {
      lorries: pending.lorries,
      breakdown: pending.breakdown,
      pos: pending.pos,
    },
    dues: dues && active
      ? {
          scope: active.scope,
          amount: active.amount,
          invoiceCount: active.invoices.length,
          invoiceListText: invoiceListText(active.invoices),
          outstanding: dues.outstanding,
          overdueOutstanding: dues.overdueOutstanding,
          inTransitOutstanding: dues.inTransitOutstanding,
          overdueCount: dues.overdueInvoices.length,
          totalInvoiceCount: dues.invoices.length,
          // Every unsettled invoice (overdue AND upcoming), oldest due first - the
          // ledger's picker lets the sender choose which ones to quote rather than
          // the server deciding for them.
          invoices: [...dues.invoices]
            .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())
            .map((i) => ({
              dispatchId: i.dispatchId,
              invoiceNumber: i.invoiceNumber,
              outstanding: i.outstanding,
              dueDate: i.dueDate.toISOString(),
              overdue: i.overdue,
              inTransit: i.inTransit,
              brokerId: i.brokerId,
              brokerName: i.brokerId ? brokerName.get(i.brokerId) ?? null : null,
            })),
          // Full per-broker totals across ALL their invoices, not just the default
          // scope - the picker can select an invoice outside that scope, and the
          // "Send to" broker line needs to be able to reflect it.
          brokers: dues.brokers.map((b) => {
            const theirs = dues.invoices.filter((i) => i.brokerId === b.id);
            return {
              id: b.id,
              name: b.name,
              phone: b.phone,
              invoiceCount: theirs.length,
              outstanding: theirs.reduce((s, i) => s + i.outstanding, 0),
            };
          }),
        }
      : null,
  });
}

/**
 * Send the payment reminder from the Party Ledger to the buyer, the broker(s)
 * behind the due invoices, or both. Each broker is only told about the invoices
 * they brokered - another broker's business is none of theirs.
 *
 * Every leg reports itself: one recipient with no phone on file must not
 * suppress the others, so a partial send answers 200 with the per-recipient
 * breakdown and only an all-legs failure is an error.
 */
export async function sendPartyPaymentReminder(req: Request, res: Response) {
  const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {}) as {
    target?: string;
    brokerIds?: string[];
    dispatchIds?: string[];
  };
  const result = await runPartyPaymentReminderCore(req.params.partyId, body);
  res.json({
    ok: true,
    ...result,
    message: `Payment reminder sent to ${result.sent.map((s) => s.recipient).join(', ')}${
      result.failed.length ? ` (failed: ${result.failed.map((f) => `${f.recipient} - ${f.error}`).join('; ')})` : ''
    }`,
  });
}

// --- Party Ledger reminder schedule ("Schedule" option) ---------------------

const REMINDER_FREQUENCIES = ['DAILY', 'WEEKLY', 'INTERVAL'] as const;
const REMINDER_TARGETS = ['PARTY', 'BROKER', 'BOTH'] as const;
const REMINDER_STOP_CONDITIONS = ['UNTIL_PAID', 'UNTIL_DATE', 'AFTER_COUNT', 'MANUAL'] as const;

/** GET - the party's current schedule, or `null` if none has been set up yet. */
export async function getPartyReminderSchedule(req: Request, res: Response) {
  const schedule = await prisma.partyReminderSchedule.findUnique({ where: { partyId: req.params.partyId } });
  res.json(schedule);
}

/**
 * PUT - create or fully replace the party's reminder schedule. Every field is
 * required so the client always sends a complete, self-consistent shape
 * (e.g. never a WEEKLY with no days, or an AFTER_COUNT with no maxSends) -
 * see the matching validation on each conditional field below.
 */
export async function upsertPartyReminderSchedule(req: Request, res: Response) {
  const party = await prisma.party.findUnique({ where: { id: req.params.partyId }, select: { id: true } });
  if (!party) throw new HttpError(404, 'Party not found');

  const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {}) as {
    enabled?: unknown;
    hour?: unknown;
    minute?: unknown;
    frequency?: unknown;
    daysOfWeek?: unknown;
    intervalDays?: unknown;
    target?: unknown;
    stopCondition?: unknown;
    endDate?: unknown;
    maxSends?: unknown;
  };

  const enabled = body.enabled !== false;
  const hour = body.hour;
  const minute = body.minute;
  if (!Number.isInteger(hour) || (hour as number) < 0 || (hour as number) > 23) {
    throw new HttpError(400, 'hour must be an integer 0-23');
  }
  if (!Number.isInteger(minute) || (minute as number) < 0 || (minute as number) > 59) {
    throw new HttpError(400, 'minute must be an integer 0-59');
  }

  const frequency = body.frequency;
  if (typeof frequency !== 'string' || !REMINDER_FREQUENCIES.includes(frequency as typeof REMINDER_FREQUENCIES[number])) {
    throw new HttpError(400, `frequency must be one of ${REMINDER_FREQUENCIES.join(', ')}`);
  }

  let daysOfWeek: number[] = [];
  if (frequency === 'WEEKLY') {
    if (!Array.isArray(body.daysOfWeek) || !body.daysOfWeek.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) || body.daysOfWeek.length === 0) {
      throw new HttpError(400, 'daysOfWeek must be a non-empty array of integers 0-6 when frequency is WEEKLY');
    }
    daysOfWeek = [...new Set(body.daysOfWeek as number[])].sort((a, b) => a - b);
  }

  let intervalDays: number | null = null;
  if (frequency === 'INTERVAL') {
    if (!Number.isInteger(body.intervalDays) || (body.intervalDays as number) < 1 || (body.intervalDays as number) > 365) {
      throw new HttpError(400, 'intervalDays must be an integer 1-365 when frequency is INTERVAL');
    }
    intervalDays = body.intervalDays as number;
  }

  const target = body.target;
  if (typeof target !== 'string' || !REMINDER_TARGETS.includes(target as typeof REMINDER_TARGETS[number])) {
    throw new HttpError(400, `target must be one of ${REMINDER_TARGETS.join(', ')}`);
  }

  const stopCondition = body.stopCondition;
  if (typeof stopCondition !== 'string' || !REMINDER_STOP_CONDITIONS.includes(stopCondition as typeof REMINDER_STOP_CONDITIONS[number])) {
    throw new HttpError(400, `stopCondition must be one of ${REMINDER_STOP_CONDITIONS.join(', ')}`);
  }

  let endDate: Date | null = null;
  if (stopCondition === 'UNTIL_DATE') {
    const parsed = typeof body.endDate === 'string' ? new Date(body.endDate) : null;
    if (!parsed || Number.isNaN(parsed.getTime())) {
      throw new HttpError(400, 'endDate must be a valid date when stopCondition is UNTIL_DATE');
    }
    endDate = parsed;
  }

  let maxSends: number | null = null;
  if (stopCondition === 'AFTER_COUNT') {
    if (!Number.isInteger(body.maxSends) || (body.maxSends as number) < 1) {
      throw new HttpError(400, 'maxSends must be a positive integer when stopCondition is AFTER_COUNT');
    }
    maxSends = body.maxSends as number;
  }

  const schedule = await prisma.partyReminderSchedule.upsert({
    where: { partyId: party.id },
    create: {
      partyId: party.id,
      enabled,
      hour: hour as number,
      minute: minute as number,
      frequency,
      daysOfWeek,
      intervalDays,
      target,
      stopCondition,
      endDate,
      maxSends,
    },
    update: {
      enabled,
      hour: hour as number,
      minute: minute as number,
      frequency,
      daysOfWeek,
      intervalDays,
      target,
      stopCondition,
      endDate,
      maxSends,
      // Re-enabling (or re-saving) a schedule clears any earlier auto-stop and
      // resets the count - the user is deliberately (re)starting it fresh.
      stoppedReason: null,
      sendsCount: 0,
      lastSentKey: null,
    },
  });
  res.json(schedule);
}

/** DELETE - remove the party's reminder schedule entirely. */
export async function deletePartyReminderSchedule(req: Request, res: Response) {
  await prisma.partyReminderSchedule.deleteMany({ where: { partyId: req.params.partyId } });
  res.json({ ok: true });
}

/**
 * Send a party's account statement via WhatsApp for a given date range, as a PDF
 * document header with a five-figure summary in the body.
 *
 * Deliberately NOT scoped to the ledger page's kind tab. `runningBalance` is
 * computed across the whole ledger, so a kind-filtered statement can't reconcile:
 * with receipts alone you get opening 4,33,125 Dr less 6,22,265 in credits but a
 * closing of 35,298 Dr, because the sales that moved the balance in between are
 * hidden. Re-running the balance over just the filtered rows would print a
 * closing that contradicts the party's real account. A statement of account has
 * to carry every voucher for the period, so that's what goes out.
 */
export async function sendPartyLedgerWhatsApp(req: Request, res: Response) {
  try {
    const { partyId } = req.params;
    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {}) as { fromDate?: string; toDate?: string; phone?: string };
    const { fromDate, toDate, phone } = body;

    const statement = await buildPartyStatementData(partyId);
    if (!statement) throw new HttpError(404, 'Party not found');
    const { party, transactions } = statement;

    const targetPhone = phone?.trim() || party.phone || party.phone2;
    if (!targetPhone) {
      throw new HttpError(400, `No valid phone number for ${party.name}. Please enter one in Parties or in the prompt.`);
    }

    let txns = transactions;
    if (fromDate) txns = txns.filter((t) => t.date >= fromDate);
    if (toDate) txns = txns.filter((t) => t.date <= toDate + 'T23:59:59');

    const rawOpening = Number((party as any).openingBalance || 0);
    const isDr = (party as any).openingBalanceType === 'DR' || ((party as any).openingBalanceType !== 'CR' && party.type === 'BUYER');
    const signedMasterOpening = rawOpening ? (isDr ? rawOpening : -rawOpening) : 0;

    const firstTxn = txns[0];
    const lastTxn = txns[txns.length - 1];
    const opening = firstTxn ? (firstTxn.runningBalance || 0) - (firstTxn.debit || 0) + (firstTxn.credit || 0) : signedMasterOpening;
    const closing = lastTxn ? (lastTxn.runningBalance || 0) : signedMasterOpening;
    const totalDebit = txns.reduce((s, t) => s + (t.debit || 0), 0);
    const totalCredit = txns.reduce((s, t) => s + (t.credit || 0), 0);

    const fmtAmt = (n: number) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(Math.abs(n || 0)));
    const drcr = (n: number) => (n === 0 ? '' : n > 0 ? 'Dr' : 'Cr');

    const fromStr = fromDate ? fromDate.slice(0, 10) : firstTxn ? firstTxn.date.slice(0, 10) : 'Start';
    const toStr = toDate ? toDate.slice(0, 10) : lastTxn ? lastTxn.date.slice(0, 10) : 'As of today';
    const periodStr = `${fromStr} to ${toStr}`;

    const recentList = txns
      .slice(-5)
      .map((t) => `• ${t.date.slice(0, 10)}: ${t.particulars} (₹${fmtAmt(t.debit || t.credit || 0)})`)
      .join('\n');

    const summaryText = `*Account Statement - ${party.name}*\nPeriod: ${periodStr}\nOpening Bal: ₹${fmtAmt(opening)} ${drcr(opening)}\nTotal Debits: ₹${fmtAmt(totalDebit)}\nTotal Credits: ₹${fmtAmt(totalCredit)}\n*Closing Bal: ₹${fmtAmt(closing)} ${drcr(closing)}*\n\nRecent Activity:\n${recentList || 'No transactions in period'}`;

    // The statement PDF is the template's document header, so it has to exist
    // before we can send at all. Rendered from the same period-scoped rows as the
    // summary above, then parked in Supabase Storage for Meta to fetch.
    let document: { url: string; filename: string } | null = null;
    try {
      const profile = await getCompanyProfileRow();
      const buffer = await renderStatementPdf(
        {
          name: profile.name || 'RVP Industries',
          address: profile.address,
          gstin: profile.gstin,
          contact: profile.contact,
          stateName: profile.stateName,
          stateCode: profile.stateCode,
          pincode: profile.pincode,
          bankAccountName: profile.bankAccountName,
          bankName: profile.bankName,
          bankAccountNumber: profile.bankAccountNumber,
          bankBranchIfsc: profile.bankBranchIfsc,
          signatureHeight: profile.signatureHeight,
          stampSize: profile.stampSize,
        },
        {
          party,
          transactions: txns,
          // Period-scoped, or the totals row would contradict the rows above it.
          // Closing is the last row's running balance (opening + period movement),
          // not debits-minus-credits, which ignores the balance carried in.
          summary: {
            ...statement.summary,
            totalDebit,
            totalCredit,
            balance: Math.abs(closing),
            balanceType: closing >= 0 ? ('DR' as const) : ('CR' as const),
          },
        },
        { label: periodStr, opening, from: fromStr, to: toStr }
      );
      const slug = (s: string) => s.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
      const filename = `Account-Statement-${slug(party.name)}-${slug(fromStr)}-to-${slug(toStr)}.pdf`;
      const url = await uploadFileToStorage({ originalname: filename, mimetype: 'application/pdf', buffer } as Express.Multer.File);
      document = { url, filename };
    } catch (e) {
      logger.error('[whatsapp] party ledger statement PDF failed', e);
    }

    let result: { ok: boolean; skipped?: boolean; error?: string } = { ok: false, error: 'WhatsApp template notification skipped' };
    if (!document) {
      // Sending without the header would be rejected by Meta anyway; say so
      // plainly so the caller falls back to WhatsApp Web or the printed PDF.
      result = { ok: false, error: 'Could not prepare the statement PDF, so nothing was sent. Please try again or use WhatsApp Web.' };
    } else {
      try {
        result = await whatsappService.sendPartyLedgerStatement(
          { id: party.id, name: party.name },
          targetPhone,
          {
            period: periodStr,
            totalDebit: `₹${fmtAmt(totalDebit)}`,
            totalCredit: `₹${fmtAmt(totalCredit)}`,
            closing: `₹${fmtAmt(closing)} ${drcr(closing)}`.trim(),
          },
          document
        );
      } catch (e) {
        logger.error('[whatsapp] sendPartyLedgerWhatsApp template error', e);
        result = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    // `ok` reports whether the message actually went out - the caller shows the
    // WhatsApp Web fallback when it didn't, so a failure must not read as a send.
    res.json({
      ok: result.ok,
      skipped: result.skipped ?? false,
      message: result.ok
        ? `Statement PDF sent to ${targetPhone}`
        : result.error || 'WhatsApp send failed',
      summaryText,
      documentUrl: document?.url ?? null,
      targetPhone,
      period: periodStr,
      closingBalance: closing,
      transactionCount: txns.length,
    });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    logger.error('[whatsapp] sendPartyLedgerWhatsApp error', err);
    throw new HttpError(500, err instanceof Error ? err.message : 'Failed to send ledger statement');
  }
}

/**
 * Send a broker's brokerage-ledger statement via WhatsApp for a given date
 * range, as a PDF document header - the same shape as `sendPartyLedgerWhatsApp`,
 * fired from the "WhatsApp Ledger" button on the Brokerage Report detail page.
 *
 * Not scoped to the page's search filter, for the same reason the party
 * statement isn't scoped to its kind tab: the running balance has to carry
 * every voucher in the period or the printed closing figure won't reconcile.
 */
export async function sendBrokerLedgerWhatsApp(req: Request, res: Response) {
  try {
    const { brokerId } = req.params;
    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {}) as { fromDate?: string; toDate?: string; phone?: string };
    const { fromDate, toDate, phone } = body;

    const ledger = await buildBrokerLedgerData(brokerId);
    if (!ledger) throw new HttpError(404, 'Broker not found');
    const { broker, transactions } = ledger;

    if (isOwnBroker(broker.name)) {
      throw new HttpError(400, `${broker.name} is the own-orders marker, not a real broker - there is nothing to send.`);
    }

    const targetPhone = phone?.trim() || broker.phone;
    if (!targetPhone) {
      throw new HttpError(400, `No valid phone number for ${broker.name}. Please enter one in Brokers or in the prompt.`);
    }

    let txns = transactions;
    if (fromDate) txns = txns.filter((t) => t.date >= fromDate);
    if (toDate) txns = txns.filter((t) => t.date <= toDate + 'T23:59:59');

    const firstTxn = txns[0];
    const lastTxn = txns[txns.length - 1];
    const opening = firstTxn ? (firstTxn.runningBalance || 0) - (firstTxn.debit || 0) + (firstTxn.credit || 0) : 0;
    const closing = lastTxn ? (lastTxn.runningBalance || 0) : 0;
    const totalPaid = txns.reduce((s, t) => s + (t.debit || 0), 0);
    const totalBrokerage = txns.reduce((s, t) => s + (t.credit || 0), 0);

    const fmtAmt = (n: number) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(Math.abs(n || 0)));
    const drcr = (n: number) => (n === 0 ? '' : n > 0 ? 'Dr' : 'Cr');

    const fromStr = fromDate ? fromDate.slice(0, 10) : firstTxn ? firstTxn.date.slice(0, 10) : 'Start';
    const toStr = toDate ? toDate.slice(0, 10) : lastTxn ? lastTxn.date.slice(0, 10) : 'As of today';
    const periodStr = `${fromStr} to ${toStr}`;

    const recentList = txns
      .slice(-5)
      .map((t) => `• ${t.date.slice(0, 10)}: ${t.particulars} (₹${fmtAmt(t.debit || t.credit || 0)})`)
      .join('\n');

    const summaryText = `*Brokerage Statement - ${broker.name}*\nPeriod: ${periodStr}\nOpening Bal: ₹${fmtAmt(opening)} ${drcr(opening)}\nTotal Brokerage: ₹${fmtAmt(totalBrokerage)}\nTotal Paid: ₹${fmtAmt(totalPaid)}\n*Closing Bal: ₹${fmtAmt(closing)} ${drcr(closing)}*\n\nRecent Activity:\n${recentList || 'No transactions in period'}`;

    let document: { url: string; filename: string } | null = null;
    try {
      const profile = await getCompanyProfileRow();
      const buffer = await renderBrokerLedgerPdf(
        {
          name: profile.name || 'RVP Industries',
          address: profile.address,
          gstin: profile.gstin,
          contact: profile.contact,
          stateName: profile.stateName,
          stateCode: profile.stateCode,
          pincode: profile.pincode,
          signatureHeight: profile.signatureHeight,
          stampSize: profile.stampSize,
        },
        { broker, transactions: txns },
        { opening, from: fromStr, to: toStr }
      );
      const slug = (s: string) => s.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
      const filename = `Brokerage-Statement-${slug(broker.name)}-${slug(fromStr)}-to-${slug(toStr)}.pdf`;
      const url = await uploadFileToStorage({ originalname: filename, mimetype: 'application/pdf', buffer } as Express.Multer.File);
      document = { url, filename };
    } catch (e) {
      logger.error('[whatsapp] broker ledger statement PDF failed', e);
    }

    let result: { ok: boolean; skipped?: boolean; error?: string } = { ok: false, error: 'WhatsApp template notification skipped' };
    if (!document) {
      result = { ok: false, error: 'Could not prepare the statement PDF, so nothing was sent. Please try again or use WhatsApp Web.' };
    } else {
      try {
        result = await whatsappService.sendBrokerLedgerStatement(
          { id: broker.id, name: broker.name, waLanguage: broker.waLanguage },
          targetPhone,
          {
            period: periodStr,
            totalBrokerage: `₹${fmtAmt(totalBrokerage)}`,
            totalPaid: `₹${fmtAmt(totalPaid)}`,
            closing: `₹${fmtAmt(closing)} ${drcr(closing)}`.trim(),
          },
          document
        );
      } catch (e) {
        logger.error('[whatsapp] sendBrokerLedgerWhatsApp template error', e);
        result = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    res.json({
      ok: result.ok,
      skipped: result.skipped ?? false,
      message: result.ok
        ? `Statement PDF sent to ${targetPhone}`
        : result.error || 'WhatsApp send failed',
      summaryText,
      documentUrl: document?.url ?? null,
      targetPhone,
      period: periodStr,
      closingBalance: closing,
      transactionCount: txns.length,
    });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    logger.error('[whatsapp] sendBrokerLedgerWhatsApp error', err);
    throw new HttpError(500, err instanceof Error ? err.message : 'Failed to send broker ledger statement');
  }
}

// --- Lorry booking register (Freight Dues → Lorry Confirmations) -------------

/**
 * The register, newest first. `status` accepts WAITING / USED / DISMISSED / ALL;
 * the legacy DRAFT and CONFIRMED rows are folded into WAITING and USED so the
 * pre-register history reads as one list.
 */
export async function listTransportConfirmations(req: Request, res: Response) {
  const status = ((req.query.status as string) || 'WAITING').toUpperCase();
  const where =
    status === 'ALL'
      ? undefined
      : status === 'WAITING'
        ? { status: { in: [...WAITING_STATES] } }
        : status === 'USED'
          ? { status: { in: [...USED_STATES] } }
          : { status: 'DISMISSED' as const };

  const rows = await prisma.transportConfirmation.findMany({
    where,
    orderBy: [{ messageDate: 'desc' }, { createdAt: 'desc' }],
    take: 500,
  });

  // The dispatch a used booking went out on, so the register can name the buyer
  // rather than showing a bare id.
  const dispatchIds = rows.map((r) => r.saleDispatchId).filter((id): id is string => !!id);
  const dispatches = dispatchIds.length
    ? await prisma.saleDispatch.findMany({
        where: { id: { in: dispatchIds } },
        select: {
          id: true,
          dispatchDate: true,
          invoiceNumber: true,
          saleOrder: { select: { destination: true, buyer: { select: { name: true } } } },
        },
      })
    : [];
  const byId = new Map(dispatches.map((d) => [d.id, d]));

  res.json(
    rows.map((r) => {
      const d = r.saleDispatchId ? byId.get(r.saleDispatchId) : null;
      return {
        ...r,
        dispatch: d
          ? {
              id: d.id,
              dispatchDate: d.dispatchDate,
              invoiceNumber: d.invoiceNumber,
              buyer: d.saleOrder?.buyer?.name ?? null,
              destination: d.saleOrder?.destination ?? null,
            }
          : null,
      };
    }),
  );
}

/**
 * The waiting booking for a lorry number, used by the dispatch dialog to fill in
 * the driver as the number is typed. Answers 200 with `null` when nothing is
 * booked on that lorry - a miss is the normal case, not an error.
 */
export async function lookupLorryConfirmation(req: Request, res: Response) {
  const raw = typeof req.query.lorryNumber === 'string' ? req.query.lorryNumber : '';
  const row = await findWaitingConfirmation(raw);
  res.json(row ?? null);
}

const EDITABLE_TEXT = ['driverName', 'driverPhone', 'fromPlace', 'toPlace'] as const;

/**
 * Correct a booking. Gemini reads these off free-text WhatsApp messages, so a
 * transposed lorry number or a missing driver name has to be fixable - otherwise
 * the row never matches a dispatch and the auto-fill silently does nothing.
 */
export async function updateTransportConfirmation(req: Request, res: Response) {
  const row = await prisma.transportConfirmation.findUnique({ where: { id: req.params.id } });
  if (!row) throw new HttpError(404, 'Lorry confirmation not found');

  const body = (req.body ?? {}) as Record<string, unknown>;
  const data: Record<string, unknown> = {};

  for (const key of EDITABLE_TEXT) {
    if (body[key] !== undefined) {
      const v = typeof body[key] === 'string' ? (body[key] as string).trim() : '';
      data[key] = v || null;
    }
  }
  if (body.lorryNumber !== undefined) {
    data.lorryNumber = normalizeLorryNumber(body.lorryNumber as string);
  }
  if (body.messageDate !== undefined) {
    const raw = body.messageDate as string;
    if (!raw) data.messageDate = null;
    else {
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) throw new HttpError(400, 'Date is not valid');
      data.messageDate = d;
    }
  }
  for (const key of ['tonnageKg', 'freightAmount'] as const) {
    if (body[key] === undefined) continue;
    const raw = body[key];
    if (raw === null || raw === '') {
      data[key] = null;
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${key} must be a positive number`);
    data[key] = key === 'tonnageKg' ? Math.round(n) : n;
  }

  const updated = await prisma.transportConfirmation.update({ where: { id: row.id }, data });
  res.json(updated);
}

/** Hide a mis-parsed or irrelevant message from the register. */
export async function dismissTransportConfirmation(req: Request, res: Response) {
  const row = await prisma.transportConfirmation.findUnique({ where: { id: req.params.id } });
  if (!row) throw new HttpError(404, 'Lorry confirmation not found');
  const updated = await prisma.transportConfirmation.update({
    where: { id: row.id },
    data: { status: 'DISMISSED', saleDispatchId: null },
  });
  res.json(updated);
}

/**
 * Put a dismissed booking back on the waiting list. A row is normally dismissed
 * because it looked wrong; once corrected it has to be able to come back, or the
 * lorry it books can never be matched.
 */
export async function restoreTransportConfirmation(req: Request, res: Response) {
  const row = await prisma.transportConfirmation.findUnique({ where: { id: req.params.id } });
  if (!row) throw new HttpError(404, 'Lorry confirmation not found');
  const updated = await prisma.transportConfirmation.update({
    where: { id: row.id },
    data: { status: 'WAITING' },
  });
  res.json(updated);
}

// --- Dispatch bundle ---------------------------------------------------------

/**
 * The manual "Send via WhatsApp" button. The same bundle also goes out
 * automatically after a combined IRN + E-Way Bill generation, so the work lives
 * in dispatchWhatsapp.service; this route stays available as the re-send path.
 */
export async function sendDispatchWhatsApp(req: Request, res: Response) {
  res.json(await sendDispatchBundleWhatsApp(req.params.id));
}

/**
 * Re-send just the driver's message for a dispatch - normally only fired once,
 * at dispatch creation. Useful when a driver lost the message, and to verify a
 * template fix against Settings -> WhatsApp's test number without creating a
 * new dispatch.
 */
export async function resendDriverWhatsApp(req: Request, res: Response) {
  res.json(await resendDispatchDriverWhatsApp(req.params.id));
}
