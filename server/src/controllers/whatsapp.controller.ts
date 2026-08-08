import type { Request, Response } from 'express';
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
import { JOB_RUNNERS } from '../jobs/whatsappJobs.js';
import { buildPartyStatementData } from './ledger.controller.js';

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

  const pendingPOs = await prisma.purchaseOrder.findMany({
    where: { partyId: party.id, status: 'PENDING' },
    include: { stockIns: { select: { id: true } } },
    orderBy: { poDate: 'asc' },
  });
  const pending = pendingPOs
    .map((po) => ({
      poNumber: po.poNumber,
      pricePerKg: Number(po.pricePerKg),
      remaining: Math.max(0, (po.lorryCount || 1) - po.stockIns.length),
    }))
    .filter((p) => p.remaining > 0);
  const pendingLorries = pending.reduce((s, p) => s + p.remaining, 0);
  if (pendingLorries === 0) {
    throw new HttpError(400, 'No pending lorries against this party - nothing to remind about');
  }
  // Priced per-PO breakdown, price → lorries → (PO), e.g.
  // "• ₹95/kg - 3 lorries (RVP/01)\n• ₹96/kg - 2 lorries (RVP/02)".
  const breakdown = pending
    .map((p) => `• ₹${p.pricePerKg}/kg - ${p.remaining} lorr${p.remaining === 1 ? 'y' : 'ies'} (${p.poNumber ?? '-'})`)
    .join('\n');

  const result = await whatsappService.sendReminder(
    { id: party.id, name: party.name, phone: party.phone, phone2: party.phone2 },
    pendingLorries,
    breakdown
  );
  if (!result.ok) throw new HttpError(502, result.error ?? 'WhatsApp send failed');
  res.json({ ok: true, pendingLorries, breakdown });
}

/**
 * Send a party's account ledger statement via WhatsApp for a given date range.
 */
export async function sendPartyLedgerWhatsApp(req: Request, res: Response) {
  const { partyId } = req.params;
  const { fromDate, toDate, phone } = (req.body ?? {}) as { fromDate?: string; toDate?: string; phone?: string };

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

  const firstTxn = txns[0];
  const lastTxn = txns[txns.length - 1];
  const opening = firstTxn ? (firstTxn.runningBalance || 0) - (firstTxn.debit || 0) + (firstTxn.credit || 0) : 0;
  const closing = lastTxn ? (lastTxn.runningBalance || 0) : 0;
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

  const result = await whatsappService.sendSalesDuesReminder(
    { id: party.id, name: party.name, phone: targetPhone },
    Math.abs(closing),
    `Period ${periodStr} | Opening: ₹${fmtAmt(opening)} ${drcr(opening)} | Closing: ₹${fmtAmt(closing)} ${drcr(closing)}`
  );

  res.json({
    ok: true,
    message: result.ok ? 'Party ledger statement sent via WhatsApp' : (result.error || 'WhatsApp message processed'),
    summaryText,
    targetPhone,
    period: periodStr,
    closingBalance: closing,
  });
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
