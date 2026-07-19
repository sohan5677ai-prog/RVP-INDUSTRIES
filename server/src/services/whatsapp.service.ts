import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

/**
 * WhatsApp notifications via Fast2SMS (Meta Cloud API BSP), sharing the KNM
 * Multi ERP business number. Every send — success, failure or skip — is
 * recorded in WhatsAppLog so the UI can show delivery state and offer resends.
 *
 * Design rules:
 *  - NEVER throw from a notify helper: a WhatsApp hiccup must not fail the
 *    business action (PO create, payment, stock-in, dispatch) that triggered it.
 *  - Fire-and-forget: callers invoke `void whatsappService.notifyX(...)` after
 *    their transaction commits.
 *  - WHATSAPP_TEST_MODE reroutes every message to WHATSAPP_TEST_NUMBER so the
 *    whole pipeline can be exercised without messaging real parties.
 *
 * Env:
 *  - FAST2SMS_API_KEY          Fast2SMS Dev API key (Authorization header)
 *  - FAST2SMS_PHONE_NUMBER_ID  WABA phone number id of the shared business number
 *  - WHATSAPP_ENABLED          'true' to send at all (default off, like SLACK_ENABLED)
 *  - WHATSAPP_TEST_MODE        anything but 'false' reroutes to the test number
 *  - WHATSAPP_TEST_NUMBER      where test-mode messages land (owner's phone)
 *  - FAST2SMS_TMPL_<KEY>       numeric Fast2SMS message_id per approved template
 */

const FAST2SMS_URL = 'https://www.fast2sms.com/dev/whatsapp';

/** Template keys — each maps to an approved template's Fast2SMS message_id. */
export type WaTemplateKey =
  | 'PO_CREATED' // rvp_po_created: party, po number(s), lorries, price/kg
  | 'STOCKIN_CONFIRMED' // rvp_stockin_confirmed: party, lorry, po number, date
  | 'PAYMENT_SENT' // rvp_payment_sent (image header): party, amount, date, reference
  | 'DISPATCH_BROKER' // rvp_dispatch_broker (document header): order ref, lorry, driver, phone, ewb
  | 'DISPATCH_DRIVER' // rvp_dispatch_driver: lorry, party, phone, maps link
  | 'REMINDER'; // rvp_reminder: party, pending lorries, po number

function templateId(key: WaTemplateKey): string | undefined {
  return process.env[`FAST2SMS_TMPL_${key}`]?.trim() || undefined;
}

/**
 * Normalise an Indian phone number to the 12-digit "91XXXXXXXXXX" form
 * Fast2SMS expects. Returns null when the input can't be a valid mobile.
 */
export function normalizeWhatsAppNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10) digits = `91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  return null;
}

/** dd-MMM-yyyy, e.g. "17-Jul-2026" — unambiguous for Indian recipients. */
function fmtDate(d: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(d.getDate()).padStart(2, '0')}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

/** Indian-grouped amount, e.g. 450000 → "4,50,000". */
function fmtInr(amount: number): string {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(amount));
}

/** Variable values are pipe-joined on the wire — strip pipes/newlines from each. */
function cleanVar(v: string | number | null | undefined): string {
  const s = (v ?? '').toString().replace(/[|\r\n]+/g, ' ').trim();
  return s || '-';
}

interface SendArgs {
  templateKey: WaTemplateKey;
  to: string | null | undefined; // raw phone, normalised inside
  variables: Array<string | number | null | undefined>;
  mediaUrl?: string; // required by templates with a media header
  documentFilename?: string; // PDF display name
  relatedType?: string;
  relatedId?: string;
}

async function log(args: SendArgs, status: 'SENT' | 'FAILED' | 'SKIPPED', extra: { phone?: string | null; error?: string; providerId?: string }) {
  try {
    await prisma.whatsAppLog.create({
      data: {
        direction: 'OUTBOUND',
        phone: extra.phone ?? null,
        template: args.templateKey,
        body: args.variables.map(cleanVar).join(' | '),
        mediaUrl: args.mediaUrl ?? null,
        relatedType: args.relatedType ?? null,
        relatedId: args.relatedId ?? null,
        status,
        errorMessage: extra.error ?? null,
        providerId: extra.providerId ?? null,
      },
    });
  } catch (e) {
    logger.error('[whatsapp] failed to write WhatsAppLog', e);
  }
}

/**
 * Send one approved template. Never throws — the outcome (SENT/FAILED/SKIPPED)
 * is recorded in WhatsAppLog and mirrored in the return value.
 */
export async function sendWhatsAppTemplate(args: SendArgs): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  const apiKey = process.env.FAST2SMS_API_KEY;
  const phoneNumberId = process.env.FAST2SMS_PHONE_NUMBER_ID;
  const enabled = process.env.WHATSAPP_ENABLED === 'true';
  // Safety default: test mode stays ON until explicitly turned off.
  const testMode = process.env.WHATSAPP_TEST_MODE !== 'false';
  const testNumber = process.env.WHATSAPP_TEST_NUMBER;

  if (!enabled) {
    await log(args, 'SKIPPED', { error: 'WHATSAPP_ENABLED is not true' });
    return { ok: false, skipped: true, error: 'WhatsApp sending is disabled (WHATSAPP_ENABLED)' };
  }
  if (!apiKey || !phoneNumberId) {
    await log(args, 'SKIPPED', { error: 'FAST2SMS_API_KEY / FAST2SMS_PHONE_NUMBER_ID not configured' });
    return { ok: false, skipped: true, error: 'Fast2SMS credentials are not configured' };
  }
  const messageId = templateId(args.templateKey);
  if (!messageId) {
    await log(args, 'SKIPPED', { error: `FAST2SMS_TMPL_${args.templateKey} is not configured` });
    return { ok: false, skipped: true, error: `Template id for ${args.templateKey} is not configured` };
  }

  const realNumber = normalizeWhatsAppNumber(args.to);
  const target = testMode ? normalizeWhatsAppNumber(testNumber) : realNumber;
  if (!target) {
    const error = testMode
      ? 'WHATSAPP_TEST_NUMBER is missing/invalid (test mode is on)'
      : `Recipient phone "${args.to ?? ''}" is missing or not a valid Indian mobile`;
    await log(args, 'FAILED', { phone: realNumber, error });
    return { ok: false, error };
  }

  const params = new URLSearchParams({
    message_id: messageId,
    phone_number_id: phoneNumberId,
    numbers: target,
  });
  const variablesValues = args.variables.map(cleanVar).join('|');
  if (variablesValues) params.set('variables_values', variablesValues);
  if (args.mediaUrl) params.set('media_url', args.mediaUrl);
  if (args.documentFilename) params.set('document_filename', args.documentFilename);

  try {
    const res = await fetch(`${FAST2SMS_URL}?${params.toString()}`, {
      headers: { Authorization: apiKey },
    });
    const text = await res.text();
    if (!res.ok) {
      await log(args, 'FAILED', { phone: target, error: `HTTP ${res.status}: ${text.slice(0, 500)}` });
      return { ok: false, error: `Fast2SMS error ${res.status}` };
    }
    // Response may be JSON ({return: true, request_id}) or plain text — keep whatever id we can find.
    let providerId: string | undefined;
    try {
      const parsed = JSON.parse(text);
      providerId = parsed.request_id ?? parsed.message_id ?? undefined;
      if (parsed.return === false) {
        await log(args, 'FAILED', { phone: target, error: text.slice(0, 500) });
        return { ok: false, error: parsed.message ?? 'Fast2SMS rejected the message' };
      }
    } catch {
      /* plain-text success body */
    }
    await log(args, 'SENT', { phone: target, providerId });
    logger.info(`[whatsapp] ${args.templateKey} sent to ${target}${testMode ? ' (test mode)' : ''}`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log(args, 'FAILED', { phone: target, error: msg });
    logger.error(`[whatsapp] ${args.templateKey} send failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Trigger helpers — one per business event. All fire-and-forget safe.
// ---------------------------------------------------------------------------

export const whatsappService = {
  send: sendWhatsAppTemplate,

  /**
   * PO created → party. One order may split into several per-lorry POs
   * (poGroupId); send a single message covering the group.
   */
  async notifyPoCreated(pos: Array<{ id: string; poNumber: string | null }>, party: { name: string; phone: string | null }, pricePerKg: number) {
    if (pos.length === 0) return;
    const first = pos[0].poNumber ?? '';
    const last = pos[pos.length - 1].poNumber ?? '';
    const poLabel = pos.length === 1 ? first : `${first} to ${last}`;
    await sendWhatsAppTemplate({
      templateKey: 'PO_CREATED',
      to: party.phone,
      variables: [party.name, poLabel, pos.length, pricePerKg],
      relatedType: 'PO',
      relatedId: pos[0].id,
    });
  },

  /** Lorry stocked in → party. */
  async notifyStockIn(stockIn: { id: string; lorryNumber: string; arrivalDate: Date }, po: { poNumber: string | null }, party: { name: string; phone: string | null }) {
    await sendWhatsAppTemplate({
      templateKey: 'STOCKIN_CONFIRMED',
      to: party.phone,
      variables: [party.name, stockIn.lorryNumber, po.poNumber ?? '-', fmtDate(stockIn.arrivalDate)],
      relatedType: 'STOCKIN',
      relatedId: stockIn.id,
    });
  },

  /** Payment recorded → party (screenshot attached when uploaded). */
  async notifyPaymentSent(payment: { id: string; amount: number; date: Date; reference: string | null; screenshotUrl: string | null }, party: { name: string; phone: string | null }) {
    await sendWhatsAppTemplate({
      templateKey: 'PAYMENT_SENT',
      to: party.phone,
      variables: [party.name, fmtInr(payment.amount), fmtDate(payment.date), payment.reference ?? '-'],
      mediaUrl: payment.screenshotUrl ?? undefined,
      relatedType: 'PAYMENT',
      relatedId: payment.id,
    });
  },

  /** Dispatch → driver gets the buyer's name, phone and maps link. */
  async notifyDispatchDriver(dispatch: { id: string; vehicleNumber: string | null; driverPhone: string | null }, buyer: { name: string; phone: string | null; locationLink: string | null }) {
    if (!dispatch.driverPhone) return; // no driver captured — nothing to send
    await sendWhatsAppTemplate({
      templateKey: 'DISPATCH_DRIVER',
      to: dispatch.driverPhone,
      variables: [dispatch.vehicleNumber ?? '-', buyer.name, buyer.phone ?? '-', buyer.locationLink ?? '-'],
      relatedType: 'DISPATCH',
      relatedId: dispatch.id,
    });
  },

  /**
   * Invoice + EWB + driver bundle → broker (or buyer when the order has no real
   * broker). Called from the explicit "Send via WhatsApp" action once the
   * invoice/EWB exist — not automatically at dispatch, where they don't yet.
   */
  async sendDispatchBundle(args: {
    dispatchId: string;
    orderRef: string;
    vehicleNumber: string | null;
    driverName: string | null;
    driverPhone: string | null;
    ewbNumber: string | null;
    invoicePdfUrl?: string;
    invoiceFilename?: string;
    toPhone: string | null;
  }) {
    return sendWhatsAppTemplate({
      templateKey: 'DISPATCH_BROKER',
      to: args.toPhone,
      variables: [args.orderRef, args.vehicleNumber ?? '-', args.driverName ?? '-', args.driverPhone ?? '-', args.ewbNumber ?? '-'],
      mediaUrl: args.invoicePdfUrl,
      documentFilename: args.invoiceFilename,
      relatedType: 'DISPATCH',
      relatedId: args.dispatchId,
    });
  },

  /** Pending-loads reminder → party (manual button on the Party Ledger). */
  async sendReminder(party: { id: string; name: string; phone: string | null }, pendingLorries: number, poLabel: string) {
    return sendWhatsAppTemplate({
      templateKey: 'REMINDER',
      to: party.phone,
      variables: [party.name, pendingLorries, poLabel],
      relatedType: 'REMINDER',
      relatedId: party.id,
    });
  },

  /** Last reminder sent to this party (throttle guard for the reminder button). */
  async lastReminderAt(partyId: string): Promise<Date | null> {
    const row = await prisma.whatsAppLog.findFirst({
      where: { relatedType: 'REMINDER', relatedId: partyId, status: 'SENT' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return row?.createdAt ?? null;
  },
};
