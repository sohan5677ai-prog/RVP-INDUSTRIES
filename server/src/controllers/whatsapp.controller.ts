import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { logger } from '../lib/logger.js';
import { whatsappService, normalizeWhatsAppNumber } from '../services/whatsapp.service.js';
import { parseTransportConfirmationText } from '../lib/gemini.js';
import { sendDispatchBundleWhatsApp } from '../services/dispatchWhatsapp.service.js';
import { JOB_RUNNERS } from '../jobs/whatsappJobs.js';

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

/** Async post-processing after the webhook has been acknowledged. */
async function processInboundEvent(rawBody: unknown) {
  const { from, text } = extractInbound(rawBody);

  const logRow = await prisma.whatsAppLog.create({
    data: {
      direction: 'INBOUND',
      phone: from,
      body: text ?? JSON.stringify(rawBody).slice(0, 4000),
      status: 'RECEIVED',
    },
  });

  // A transport confirmation is a long-ish text with digits (lorry no / phone).
  if (!text || text.length < 25 || !/\d{4}/.test(text)) return;

  const parsed = await parseTransportConfirmationText(text);
  if (!parsed?.isTransportConfirmation) return;
  if (!parsed.lorryNumber && !parsed.driverPhone) return; // nothing actionable

  const draft = await prisma.transportConfirmation.create({
    data: {
      fromPhone: from ?? 'unknown',
      rawText: text,
      messageDate: parsed.messageDate ? new Date(parsed.messageDate) : null,
      fromPlace: parsed.fromPlace ?? null,
      toPlace: parsed.toPlace ?? null,
      tonnageKg: parsed.tonnageKg ?? null,
      lorryNumber: parsed.lorryNumber ?? null,
      driverName: parsed.driverName ?? null,
      driverPhone: parsed.driverPhone ?? null,
      freightAmount: parsed.freightAmount ?? null,
    },
  });
  logger.info(`[whatsapp] transport confirmation draft ${draft.id} created from ${from} (log ${logRow.id})`);
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

/** Fast2SMS event receiver. Acknowledge immediately; parse in the background. */
export async function handleWhatsAppWebhook(req: Request, res: Response) {
  res.json({ received: true });
  processWebhookEvent(req.body).catch((err) => {
    logger.error('[whatsapp] webhook processing failed', err);
  });
}

/**
 * Status callbacks and inbound messages arrive on the same endpoint. Statuses
 * must be handled first and must NOT fall through to the inbound path, which
 * would file every delivery receipt as a "received message" and send it to Gemini.
 */
async function processWebhookEvent(rawBody: unknown) {
  const statuses = extractStatusEvents(rawBody);
  if (statuses.length > 0) {
    for (const ev of statuses) await applyStatusEvent(ev);
    return;
  }
  await processInboundEvent(rawBody);
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

// --- Transport-confirmation drafts (Surya Road Transport page) --------------

export async function listTransportConfirmations(req: Request, res: Response) {
  const status = (req.query.status as string) || 'DRAFT';
  const rows = await prisma.transportConfirmation.findMany({
    where: status === 'ALL' ? undefined : { status: status as 'DRAFT' | 'CONFIRMED' | 'DISMISSED' },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.json(rows);
}

/**
 * Confirm a draft. When a saleDispatchId is supplied, copy the driver (and the
 * lorry number, if the dispatch doesn't have one yet) onto that dispatch.
 */
export async function confirmTransportConfirmation(req: Request, res: Response) {
  const draft = await prisma.transportConfirmation.findUnique({ where: { id: req.params.id } });
  if (!draft) throw new HttpError(404, 'Transport confirmation not found');
  if (draft.status !== 'DRAFT') throw new HttpError(400, 'Already reviewed');

  const saleDispatchId = (req.body?.saleDispatchId as string | undefined) || null;
  if (saleDispatchId) {
    const dispatch = await prisma.saleDispatch.findUnique({ where: { id: saleDispatchId } });
    if (!dispatch) throw new HttpError(404, 'Sale dispatch not found');
    await prisma.saleDispatch.update({
      where: { id: saleDispatchId },
      data: {
        driverName: draft.driverName ?? dispatch.driverName,
        driverPhone: draft.driverPhone ?? dispatch.driverPhone,
        vehicleNumber: dispatch.vehicleNumber ?? draft.lorryNumber,
      },
    });
  }

  const updated = await prisma.transportConfirmation.update({
    where: { id: draft.id },
    data: { status: 'CONFIRMED', saleDispatchId },
  });
  res.json(updated);
}

export async function dismissTransportConfirmation(req: Request, res: Response) {
  const draft = await prisma.transportConfirmation.findUnique({ where: { id: req.params.id } });
  if (!draft) throw new HttpError(404, 'Transport confirmation not found');
  if (draft.status !== 'DRAFT') throw new HttpError(400, 'Already reviewed');
  const updated = await prisma.transportConfirmation.update({
    where: { id: draft.id },
    data: { status: 'DISMISSED' },
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
