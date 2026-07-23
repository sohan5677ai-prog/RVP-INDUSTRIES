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
 *  - FAST2SMS_PHONE_NUMBER_ID  (optional) Fast2SMS phone-number id; omit to use the
 *                              account's connected number. Do NOT put a Meta
 *                              phone-number-id here — Fast2SMS rejects it.
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
  | 'VERIFICATION_STATEMENT' // rvp_verification_statement (document header): party, lorry, net weight, amount
  | 'PAYMENT_SENT' // rvp_payment_sent (image header): party, amount, date, reference
  | 'PAYMENT_SENT_TEXT' // rvp_payment_sent_text (no header — used when no screenshot): party, amount, date, reference
  | 'DISPATCH_PARTY' // rvp_dispatch_party (document header): buyer, invoice, lorry, qty, driver, phone — self-taken orders (no broker)
  | 'DISPATCH_PARTY_BROKER' // rvp_dispatch_party_broker (document header): buyer, invoice, lorry, qty, driver, phone, broker — buyer copy when a broker exists
  | 'DISPATCH_BROKER' // rvp_dispatch_broker (document header): broker, buyer, invoice, lorry, qty, driver, phone — broker copy
  | 'DISPATCH_DRIVER' // rvp_dispatch_driver: lorry, party, phone, maps link
  | 'REMINDER' // rvp_reminder: party, pending lorries, per-PO breakdown
  | 'PAYMENT_REMINDER' // rvp_payment_reminder: buyer, amount, overdue invoice list
  | 'OWNER_DISPATCH_REMINDER' // rvp_owner_dispatch: buyer, order, dispatch-by date, order ref
  | 'OWNER_WEEKLY_SUMMARY' // rvp_owner_weekly: date range, seed loads, sale orders, husk orders
  | 'OWNER_DUES_DIGEST'; // rvp_owner_dues: date, total receivable, overdue, top pending

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

/** Weight in tonnes with the kg in brackets, e.g. 12340 → "12.34 MT (12,340 kg)". */
function fmtWeight(kg: number): string {
  const mt = (kg / 1000).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${mt} MT (${fmtInr(kg)} kg)`;
}

/**
 * Owner/admin mobile for internal alerts: the number set in Company Settings,
 * falling back to WHATSAPP_TEST_NUMBER so the owner flows still have a target
 * before the field is filled in. Never throws.
 */
/**
 * Resolve the effective test-mode + test-number. The UI toggle stored on the
 * CompanyProfile is authoritative; the WHATSAPP_TEST_MODE / WHATSAPP_TEST_NUMBER
 * env vars are only a fallback for when the row can't be read. Never throws.
 */
export async function resolveWhatsAppMode(): Promise<{ testMode: boolean; testNumber: string | null }> {
  const envTestMode = process.env.WHATSAPP_TEST_MODE !== 'false'; // safety default: ON
  const envTestNumber = process.env.WHATSAPP_TEST_NUMBER?.trim() || null;
  try {
    const p = await prisma.companyProfile.findUnique({
      where: { id: 'default' },
      select: { whatsappTestMode: true, whatsappTestNumber: true, ownerWhatsappNumber: true },
    });
    return {
      testMode: p?.whatsappTestMode ?? envTestMode,
      testNumber: p?.whatsappTestNumber?.trim() || envTestNumber || p?.ownerWhatsappNumber?.trim() || null,
    };
  } catch {
    return { testMode: envTestMode, testNumber: envTestNumber };
  }
}

export async function resolveOwnerNumber(): Promise<string | null> {
  try {
    const profile = await prisma.companyProfile.findUnique({
      where: { id: 'default' },
      select: { ownerWhatsappNumber: true },
    });
    return profile?.ownerWhatsappNumber?.trim() || process.env.WHATSAPP_TEST_NUMBER?.trim() || null;
  } catch {
    return process.env.WHATSAPP_TEST_NUMBER?.trim() || null;
  }
}

/**
 * The internal-alert distribution list (dispatch reminders, weekly summary,
 * daily dues digest). Set as up to 3 name+number members in Settings and stored
 * as a JSON string on CompanyProfile.alertRecipients. Falls back to the single
 * ownerWhatsappNumber, then WHATSAPP_TEST_NUMBER, when the list is empty. Returns
 * de-duplicated, valid Indian mobiles only. Never throws.
 */
export async function resolveAlertRecipients(): Promise<string[]> {
  const numbers: string[] = [];
  const push = (raw: string | null | undefined) => {
    const n = normalizeWhatsAppNumber(raw);
    if (n && !numbers.includes(n)) numbers.push(n);
  };
  try {
    const profile = await prisma.companyProfile.findUnique({
      where: { id: 'default' },
      select: { alertRecipients: true, ownerWhatsappNumber: true },
    });
    if (profile?.alertRecipients) {
      try {
        const parsed = JSON.parse(profile.alertRecipients) as Array<{ name?: string; phone?: string }>;
        if (Array.isArray(parsed)) for (const r of parsed) push(r?.phone);
      } catch {
        /* malformed JSON — fall through to fallbacks */
      }
    }
    if (numbers.length === 0) push(profile?.ownerWhatsappNumber);
  } catch {
    /* DB unreachable — env fallback below */
  }
  if (numbers.length === 0) push(process.env.WHATSAPP_TEST_NUMBER);
  return numbers;
}

/** Variable values are pipe-joined on the wire — strip pipes/newlines from each. */
function cleanVar(v: string | number | null | undefined): string {
  const s = (v ?? '').toString().replace(/[|\r\n]+/g, ' ').trim();
  return s || '-';
}

interface SendArgs {
  templateKey: WaTemplateKey;
  to: string | string[] | null | undefined; // raw phone(s), normalised inside
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
 * Supports passing a single phone number or array of phone numbers (e.g. party phone 1 & 2).
 */
export async function sendWhatsAppTemplate(args: SendArgs): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  const apiKey = process.env.FAST2SMS_API_KEY;
  const phoneNumberId = process.env.FAST2SMS_PHONE_NUMBER_ID;
  const enabled = process.env.WHATSAPP_ENABLED === 'true';
  // Test mode + test number come from the Settings toggle (DB), env as fallback.
  const { testMode, testNumber } = await resolveWhatsAppMode();

  if (!enabled) {
    await log(args, 'SKIPPED', { error: 'WHATSAPP_ENABLED is not true' });
    return { ok: false, skipped: true, error: 'WhatsApp sending is disabled (WHATSAPP_ENABLED)' };
  }
  if (!apiKey) {
    await log(args, 'SKIPPED', { error: 'FAST2SMS_API_KEY not configured' });
    return { ok: false, skipped: true, error: 'Fast2SMS API key is not configured' };
  }
  const messageId = templateId(args.templateKey);
  if (!messageId) {
    await log(args, 'SKIPPED', { error: `FAST2SMS_TMPL_${args.templateKey} is not configured` });
    return { ok: false, skipped: true, error: `Template id for ${args.templateKey} is not configured` };
  }

  const rawList = (Array.isArray(args.to) ? args.to : [args.to]).filter(Boolean);
  const targets: Array<{ realNumber: string | null; targetNumber: string | null }> = [];

  for (const raw of rawList) {
    const realNumber = normalizeWhatsAppNumber(raw);
    const targetNumber = testMode ? normalizeWhatsAppNumber(testNumber) : realNumber;
    if (realNumber || targetNumber) {
      targets.push({ realNumber, targetNumber });
    }
  }

  if (targets.length === 0) {
    const error = testMode
      ? 'WHATSAPP_TEST_NUMBER is missing/invalid (test mode is on)'
      : `Recipient phone "${Array.isArray(args.to) ? args.to.join(', ') : args.to ?? ''}" is missing or not a valid Indian mobile`;
    await log(args, 'FAILED', { phone: null, error });
    return { ok: false, error };
  }

  const results: Array<{ ok: boolean; skipped?: boolean; error?: string }> = [];

  for (const { realNumber, targetNumber } of targets) {
    const target = targetNumber;
    if (!target) {
      const error = testMode
        ? 'WHATSAPP_TEST_NUMBER is missing/invalid (test mode is on)'
        : `Recipient phone "${realNumber ?? ''}" is missing or not a valid Indian mobile`;
      await log(args, 'FAILED', { phone: realNumber, error });
      results.push({ ok: false, error });
      continue;
    }

    const params = new URLSearchParams({
      message_id: messageId,
      numbers: target,
    });
    // phone_number_id is optional on Fast2SMS: when omitted it uses the number
    // connected to the account. Only send it when explicitly configured (a wrong
    // value — e.g. a Meta phone-number-id — is rejected with "not connected").
    if (phoneNumberId) params.set('phone_number_id', phoneNumberId);
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
        results.push({ ok: false, error: `Fast2SMS error ${res.status}` });
        continue;
      }
      // Response may be JSON ({return: true, request_id}) or plain text — keep whatever id we can find.
      let providerId: string | undefined;
      try {
        const parsed = JSON.parse(text);
        providerId = parsed.request_id ?? parsed.message_id ?? undefined;
        if (parsed.return === false) {
          await log(args, 'FAILED', { phone: target, error: text.slice(0, 500) });
          results.push({ ok: false, error: parsed.message ?? 'Fast2SMS rejected the message' });
          continue;
        }
      } catch {
        /* plain-text success body */
      }
      await log(args, 'SENT', { phone: target, providerId });
      logger.info(`[whatsapp] ${args.templateKey} sent to ${target}${testMode ? ' (test mode)' : ''}`);
      results.push({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await log(args, 'FAILED', { phone: target, error: msg });
      logger.error(`[whatsapp] ${args.templateKey} send failed: ${msg}`);
      results.push({ ok: false, error: msg });
    }
  }

  const anyOk = results.some((r) => r.ok);
  return anyOk ? { ok: true } : { ok: false, error: results.find((r) => r.error)?.error ?? 'Send failed' };
}

// ---------------------------------------------------------------------------
// Trigger helpers — one per business event. All fire-and-forget safe.
// ---------------------------------------------------------------------------

/**
 * Send an internal-alert template to every configured alert recipient (1..3
 * members from Settings, else the owner/test fallback). Returns a single
 * aggregate result: ok if at least one recipient was reached. Never throws.
 */
async function fanOutToAlertRecipients(
  send: (to: string) => Promise<{ ok: boolean; skipped?: boolean; error?: string }>
): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  const recipients = await resolveAlertRecipients();
  if (recipients.length === 0) return { ok: false, skipped: true, error: 'No alert recipients configured' };
  const results = await Promise.all(recipients.map((to) => send(to)));
  const anyOk = results.some((r) => r.ok);
  return anyOk ? { ok: true } : { ok: false, error: results.find((r) => r.error)?.error };
}

export const whatsappService = {
  send: sendWhatsAppTemplate,

  /**
   * PO created → party. One order may split into several per-lorry POs
   * (poGroupId); send a single message covering the group.
   */
  async notifyPoCreated(pos: Array<{ id: string; poNumber: string | null }>, party: { name: string; phone: string | null; phone2?: string | null }, pricePerKg: number) {
    if (pos.length === 0) return;
    const first = pos[0].poNumber ?? '';
    const last = pos[pos.length - 1].poNumber ?? '';
    const poLabel = pos.length === 1 ? first : `${first} to ${last}`;
    await sendWhatsAppTemplate({
      templateKey: 'PO_CREATED',
      to: [party.phone, party.phone2].filter(Boolean) as string[],
      variables: [party.name, poLabel, pos.length, pricePerKg],
      relatedType: 'PO',
      relatedId: pos[0].id,
    });
  },

  /** Lorry stocked in → party. */
  async notifyStockIn(stockIn: { id: string; lorryNumber: string; arrivalDate: Date }, po: { poNumber: string | null }, party: { name: string; phone: string | null; phone2?: string | null }) {
    await sendWhatsAppTemplate({
      templateKey: 'STOCKIN_CONFIRMED',
      to: [party.phone, party.phone2].filter(Boolean) as string[],
      variables: [party.name, stockIn.lorryNumber, po.poNumber ?? '-', fmtDate(stockIn.arrivalDate)],
      relatedType: 'STOCKIN',
      relatedId: stockIn.id,
    });
  },

  /**
   * Payment recorded → party. Uses the image-header template with the screenshot
   * when one was uploaded; otherwise falls back to a text-only template so the
   * message still goes out (the image-header template can't send without media).
   */
  async notifyPaymentSent(payment: { id: string; amount: number; date: Date; reference: string | null; screenshotUrl: string | null }, party: { name: string; phone: string | null; phone2?: string | null }) {
    const hasImage = !!payment.screenshotUrl;
    await sendWhatsAppTemplate({
      templateKey: hasImage ? 'PAYMENT_SENT' : 'PAYMENT_SENT_TEXT',
      to: [party.phone, party.phone2].filter(Boolean) as string[],
      variables: [party.name, fmtInr(payment.amount), fmtDate(payment.date), payment.reference ?? '-'],
      mediaUrl: payment.screenshotUrl ?? undefined,
      relatedType: 'PAYMENT',
      relatedId: payment.id,
    });
  },

  /**
   * Lorry unloaded & weight-verified → supplier gets the "unloaded" confirmation
   * with their account statement attached as a PDF (document header).
   */
  async notifyVerificationStatement(
    party: { id?: string; name: string; phone: string | null; phone2?: string | null },
    details: { lorryNumber: string; netWeightKg: number; amount: number },
    statementPdfUrl: string | undefined,
    statementFilename: string | undefined,
    relatedId: string
  ) {
    await sendWhatsAppTemplate({
      templateKey: 'VERIFICATION_STATEMENT',
      to: [party.phone, party.phone2].filter(Boolean) as string[],
      variables: [party.name, details.lorryNumber, fmtWeight(details.netWeightKg), fmtInr(details.amount)],
      mediaUrl: statementPdfUrl,
      documentFilename: statementFilename,
      relatedType: 'VERIFICATION',
      relatedId,
    });
  },

  /** Dispatch → driver gets the buyer's name, phone and maps link. Returns null when no driver phone. */
  async notifyDispatchDriver(dispatch: { id: string; vehicleNumber: string | null; driverPhone: string | null }, buyer: { name: string; phone: string | null; locationLink: string | null }) {
    if (!dispatch.driverPhone) return null; // no driver captured — nothing to send
    return sendWhatsAppTemplate({
      templateKey: 'DISPATCH_DRIVER',
      to: dispatch.driverPhone,
      variables: [dispatch.vehicleNumber ?? '-', buyer.name, buyer.phone ?? '-', buyer.locationLink ?? '-'],
      relatedType: 'DISPATCH',
      relatedId: dispatch.id,
    });
  },

  /**
   * Invoice + EWB + driver details → the buyer (party). Fired from the explicit
   * "Send via WhatsApp" action once the invoice/EWB exist. When the order came
   * through a broker, `brokerName` is set and a broker-reference template is used
   * so the buyer sees whose broking it was; self-taken orders omit that line.
   */
  async sendDispatchToParty(args: {
    dispatchId: string;
    buyerName: string;
    orderRef: string;
    vehicleNumber: string | null;
    quantityKg: number | null;
    driverName: string | null;
    driverPhone: string | null;
    brokerName?: string | null; // set → include the "Through Broker" line
    documentUrl?: string; // combined Tax Invoice + EWB PDF
    documentFilename?: string;
    toPhone: string | string[] | null;
  }) {
    const base = [
      args.buyerName,
      args.orderRef,
      args.vehicleNumber ?? '-',
      args.quantityKg != null ? fmtWeight(args.quantityKg) : '-',
      args.driverName ?? '-',
      args.driverPhone ?? '-',
    ];
    const hasBroker = !!args.brokerName;
    return sendWhatsAppTemplate({
      templateKey: hasBroker ? 'DISPATCH_PARTY_BROKER' : 'DISPATCH_PARTY',
      to: args.toPhone,
      variables: hasBroker ? [...base, args.brokerName] : base,
      mediaUrl: args.documentUrl,
      documentFilename: args.documentFilename,
      relatedType: 'DISPATCH',
      relatedId: args.dispatchId,
    });
  },

  /**
   * Invoice + EWB + driver details → the broker, greeting them and naming the
   * buyer so they know whose order it is. Only sent when the order has a real
   * broker. Called from the explicit "Send via WhatsApp" action.
   */
  async sendDispatchBundle(args: {
    dispatchId: string;
    recipientName: string; // broker name
    buyerName: string;
    orderRef: string;
    vehicleNumber: string | null;
    quantityKg: number | null;
    driverName: string | null;
    driverPhone: string | null;
    documentUrl?: string; // combined Tax Invoice + EWB PDF
    documentFilename?: string;
    toPhone: string | null;
  }) {
    return sendWhatsAppTemplate({
      templateKey: 'DISPATCH_BROKER',
      to: args.toPhone,
      variables: [
        args.recipientName,
        args.buyerName,
        args.orderRef,
        args.vehicleNumber ?? '-',
        args.quantityKg != null ? fmtWeight(args.quantityKg) : '-',
        args.driverName ?? '-',
        args.driverPhone ?? '-',
      ],
      mediaUrl: args.documentUrl,
      documentFilename: args.documentFilename,
      relatedType: 'DISPATCH',
      relatedId: args.dispatchId,
    });
  },

  /** Pending-loads reminder → party (manual button on the Party Ledger). */
  async sendReminder(party: { id: string; name: string; phone: string | null; phone2?: string | null }, pendingLorries: number, poLabel: string) {
    return sendWhatsAppTemplate({
      templateKey: 'REMINDER',
      to: [party.phone, party.phone2].filter(Boolean) as string[],
      variables: [party.name, pendingLorries, poLabel],
      relatedType: 'REMINDER',
      relatedId: party.id,
    });
  },

  /**
   * Sales-dues reminder → buyer. `invoiceListText` is the pre-formatted list of
   * overdue invoices (e.g. "RVP/12 (₹1,20,000) · RVP/15 (₹80,000)"). Fired by the
   * daily job and by the manual "Remind" button on the ledger.
   */
  async sendSalesDuesReminder(buyer: { id: string; name: string; phone: string | null; phone2?: string | null }, outstanding: number, invoiceListText: string) {
    return sendWhatsAppTemplate({
      templateKey: 'PAYMENT_REMINDER',
      to: [buyer.phone, buyer.phone2].filter(Boolean) as string[],
      variables: [buyer.name, fmtInr(outstanding), invoiceListText],
      relatedType: 'PAYMENT_REMINDER',
      relatedId: buyer.id,
    });
  },

  /**
   * Owner alert: an advance sale order's dispatch date has arrived but it is not
   * yet dispatched. Goes to the owner number (Settings), NOT the buyer.
   */
  async notifyOwnerDispatch(order: { id: string; buyerName: string; orderSummary: string; dispatchBy: Date; ref: string }) {
    return fanOutToAlertRecipients((to) =>
      sendWhatsAppTemplate({
        templateKey: 'OWNER_DISPATCH_REMINDER',
        to,
        variables: [order.buyerName, order.orderSummary, fmtDate(order.dispatchBy), order.ref],
        relatedType: 'OWNER_DISPATCH_REMINDER',
        relatedId: order.id,
      })
    );
  },

  /** Owner weekly business summary. */
  async sendOwnerWeeklySummary(range: string, counts: { seedLoads: number; saleOrders: number; huskOrders: number }, weekKey: string) {
    return fanOutToAlertRecipients((to) =>
      sendWhatsAppTemplate({
        templateKey: 'OWNER_WEEKLY_SUMMARY',
        to,
        variables: [range, counts.seedLoads, counts.saleOrders, counts.huskOrders],
        relatedType: 'OWNER_WEEKLY_SUMMARY',
        relatedId: weekKey,
      })
    );
  },

  /** Owner daily outstanding-sales-dues digest. */
  async sendOwnerDuesDigest(totals: { asOn: Date; totalReceivable: number; overdue: number; topPending: string }, dayKey: string) {
    return fanOutToAlertRecipients((to) =>
      sendWhatsAppTemplate({
        templateKey: 'OWNER_DUES_DIGEST',
        to,
        variables: [fmtDate(totals.asOn), fmtInr(totals.totalReceivable), fmtInr(totals.overdue), totals.topPending],
        relatedType: 'OWNER_DUES_DIGEST',
        relatedId: dayKey,
      })
    );
  },

  /** Last reminder sent to this party (throttle guard for the reminder button). */
  async lastReminderAt(partyId: string): Promise<Date | null> {
    return this.lastSentAt('REMINDER', partyId);
  },

  /**
   * Timestamp of the most recent SENT message of a given relatedType/relatedId.
   * Used by scheduled jobs to throttle (buyer dues reminders) and to guard against
   * duplicate owner digests when the process restarts within the same window.
   */
  async lastSentAt(relatedType: string, relatedId: string): Promise<Date | null> {
    const row = await prisma.whatsAppLog.findFirst({
      where: { relatedType, relatedId, status: 'SENT' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return row?.createdAt ?? null;
  },
};
