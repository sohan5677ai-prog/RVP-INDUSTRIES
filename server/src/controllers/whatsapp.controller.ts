import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { logger } from '../lib/logger.js';
import { whatsappService } from '../services/whatsapp.service.js';
import { parseTransportConfirmationText } from '../lib/gemini.js';
import { buildInvoicePdfData } from '../services/saleDocumentEmail.service.js';
import { renderInvoicePdf } from '../lib/invoicePdf.js';
import { renderEwbPdf } from '../lib/ewbPdf.js';
import { qrPngBuffer } from '../lib/qrcode.js';
import { mergePdfs } from '../lib/pdfMerge.js';
import { uploadFileToStorage } from '../lib/upload.js';
import { JOB_RUNNERS } from '../jobs/whatsappJobs.js';

// ---------------------------------------------------------------------------
// Inbound webhook (public — Fast2SMS calls this, no JWT)
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

/** Fast2SMS event receiver. Acknowledge immediately; parse in the background. */
export async function handleWhatsAppWebhook(req: Request, res: Response) {
  res.json({ received: true });
  processInboundEvent(req.body).catch((err) => {
    logger.error('[whatsapp] inbound processing failed', err);
  });
}

/**
 * Run a scheduled WhatsApp job on demand (public, secret-guarded — so an external
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

const REMINDER_THROTTLE_MS = 4 * 60 * 60 * 1000; // 4h — a double-click must not spam the party

/**
 * "Remind about pending loads" button on the Party Ledger: counts the lorries
 * still to arrive across the party's PENDING POs and sends rvp_reminder.
 */
export async function sendPartyReminder(req: Request, res: Response) {
  const party = await prisma.party.findUnique({ where: { id: req.params.partyId } });
  if (!party) throw new HttpError(404, 'Party not found');
  if (!party.phone && !party.phone2) throw new HttpError(400, `${party.name} has no phone number on file — add one in Parties first`);

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
    throw new HttpError(400, 'No pending lorries against this party — nothing to remind about');
  }
  // Priced per-PO breakdown, e.g. "RVP/01: 3 lorry @ ₹95/kg · RVP/02: 2 @ ₹96/kg".
  const breakdown = pending
    .map((p) => `${p.poNumber ?? '-'}: ${p.remaining} lorry @ ₹${p.pricePerKg}/kg`)
    .join(' · ');

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
 * "Send via WhatsApp" for a dispatched lorry: the broker (or the buyer, when
 * the order has no real broker — a broker named "RVP" means our own order) gets
 * the tax-invoice PDF + EWB + driver details, and the driver gets the buyer's
 * name/phone/maps link. Requires the tax invoice to be raised first.
 */
export async function sendDispatchWhatsApp(req: Request, res: Response) {
  const { dispatch, order, pdfData } = await buildInvoicePdfData(req.params.id);

  // A broker named "RVP" (or no broker) means it's our own order — the buyer is
  // messaged directly with no broker reference; otherwise the buyer's copy names
  // the broker and the broker gets their own greeting copy.
  const broker = order.brokerId
    ? await prisma.broker.findUnique({ where: { id: order.brokerId } })
    : null;
  const isOwnBroker = !broker || broker.name.trim().toUpperCase() === 'RVP';
  const brokerName = isOwnBroker ? null : broker!.name;

  // A WhatsApp template message carries only ONE document. So when an E-Way Bill
  // exists, render it too and MERGE it onto the tax invoice, producing a single
  // combined PDF (invoice pages + EWB page) for the template's document header.
  const invoiceBuffer = await renderInvoicePdf(pdfData);
  const hasEwb = !!(dispatch.ewbNumber && dispatch.ewbDate && dispatch.ewbValidUpto);
  let buffer = invoiceBuffer;
  let filename = `${dispatch.invoiceNumber!.replace(/\//g, '-')}.pdf`;
  if (hasEwb) {
    const ewbBuffer = await renderEwbPdf({
      company: pdfData.company,
      buyer: pdfData.buyer,
      invoiceNumber: pdfData.invoiceNumber,
      invoiceDate: pdfData.invoiceDate,
      vehicleNumber: pdfData.vehicleNumber,
      line: pdfData.line,
      gstRate: pdfData.gstRate,
      ewbNumber: dispatch.ewbNumber!,
      ewbDate: dispatch.ewbDate!,
      ewbValidUpto: dispatch.ewbValidUpto!,
      ewbDistance: dispatch.ewbDistance,
      dispatchDate: dispatch.dispatchDate,
      qrPngBuffer: await qrPngBuffer(dispatch.ewbNumber!),
    });
    buffer = await mergePdfs([invoiceBuffer, ewbBuffer]);
    filename = `Invoice-EWB-${dispatch.invoiceNumber!.replace(/\//g, '-')}.pdf`;
  }
  // Park the (combined) PDF in Supabase Storage so Fast2SMS can fetch it as the
  // template's document header.
  const documentUrl = await uploadFileToStorage({
    originalname: filename,
    mimetype: 'application/pdf',
    buffer,
  } as Express.Multer.File);

  // Each leg is sent independently: one failing (e.g. a missing phone or a
  // not-yet-approved template) must never suppress the others. In particular the
  // driver leg used to sit behind the bundle's throw and silently never ran.
  const outcome = (r: { ok: boolean; skipped?: boolean; error?: string }) =>
    r.ok ? 'sent' : r.skipped ? 'skipped' : 'failed';

  // Party (buyer) — always. Includes the broker reference when there's a real broker.
  const buyerPhones = [order.buyer.phone, order.buyer.phone2].filter(Boolean) as string[];
  const partyResult = buyerPhones.length > 0
    ? await whatsappService.sendDispatchToParty({
        dispatchId: dispatch.id,
        buyerName: order.buyer.name,
        orderRef: dispatch.invoiceNumber!,
        vehicleNumber: dispatch.vehicleNumber,
        quantityKg: dispatch.weightKg,
        driverName: dispatch.driverName,
        driverPhone: dispatch.driverPhone,
        brokerName,
        documentUrl,
        documentFilename: filename,
        toPhone: buyerPhones,
      })
    : { ok: false, skipped: true, error: `${order.buyer.name} has no phone number on file` };

  // Broker — only when the order came through a real broker with a phone on file.
  let brokerResult: { ok: boolean; skipped?: boolean; error?: string } | null = null;
  if (brokerName && broker?.phone) {
    brokerResult = await whatsappService.sendDispatchBundle({
      dispatchId: dispatch.id,
      recipientName: broker.name,
      buyerName: order.buyer.name,
      orderRef: dispatch.invoiceNumber!,
      vehicleNumber: dispatch.vehicleNumber,
      quantityKg: dispatch.weightKg,
      driverName: dispatch.driverName,
      driverPhone: dispatch.driverPhone,
      documentUrl,
      documentFilename: filename,
      toPhone: broker.phone,
    });
  } else if (brokerName && !broker?.phone) {
    brokerResult = { ok: false, skipped: true, error: `${broker!.name} has no phone number on file` };
  }

  // Driver — best-effort, independent of the above; returns early when no driver phone.
  const driverResult = await whatsappService.notifyDispatchDriver(
    { id: dispatch.id, vehicleNumber: dispatch.vehicleNumber, driverPhone: dispatch.driverPhone },
    { name: order.buyer.name, phone: order.buyer.phone, locationLink: order.buyer.locationLink }
  );

  res.json({
    ok: partyResult.ok || !!brokerResult?.ok,
    party: outcome(partyResult),
    broker: brokerResult ? outcome(brokerResult) : 'na',
    driver: dispatch.driverPhone ? 'sent' : 'skipped',
  });
}
