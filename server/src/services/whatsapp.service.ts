import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { istCalendar } from '../lib/istDate.js';
import { resolveLatLngFromMapsLink } from '../lib/mapsLink.js';

/**
 * WhatsApp notifications via Fast2SMS (Meta Cloud API BSP), sharing the KNM
 * Multi ERP business number. Every send - success, failure or skip - is
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
 *  - FAST2SMS_PHONE_NUMBER_ID  Fast2SMS phone-number id; optional for the simple
 *                              GET send (omit to use the account's connected
 *                              number) but REQUIRED for location-header templates
 *                              (DISPATCH_DRIVER), which go over the separate
 *                              Meta-format POST endpoint. Do NOT put a Meta
 *                              phone-number-id here - Fast2SMS rejects it.
 *  - WHATSAPP_ENABLED          'true' to send at all (default off, like SLACK_ENABLED)
 *  - WHATSAPP_TEST_MODE        anything but 'false' reroutes to the test number
 *  - WHATSAPP_TEST_NUMBER      where test-mode messages land (owner's phone)
 *  - FAST2SMS_TMPL_<KEY>       numeric Fast2SMS message_id per approved template
 *                              (used by the simple GET send)
 *  - FAST2SMS_TMPL_NAME_<KEY>  the template's approved NAME (e.g. rvp_driver),
 *                              needed only for templates sent via the Meta-format
 *                              POST endpoint (location headers can't use a numeric
 *                              message_id - Meta's template API wants the name)
 */

const FAST2SMS_URL = 'https://www.fast2sms.com/dev/whatsapp';

/** Template keys - each maps to an approved template's Fast2SMS message_id. */
export type WaTemplateKey =
  | 'PO_CREATED' // rvp_po_created: party, po number(s), lorries, price/kg
  | 'STOCKIN_CONFIRMED' // rvp_stockin_confirmed: party, lorry, po number, date
  | 'VERIFICATION_STATEMENT' // rvp_verification_statement (document header): party, lorry, net weight, amount
  | 'PAYMENT_SENT' // rvp_payment_sent (image header): party, amount, date, reference
  | 'PAYMENT_SENT_TEXT' // rvp_payment_sent_text (no header - used when no screenshot): party, amount, date, reference
  | 'RECEIPT_RECEIVED' // rvp_receipt_received: payer, amount, date, reference - Receipt has no screenshot field, text-only
  | 'DISPATCH_PARTY' // rvp_dispatch_party (document header): buyer, invoice, lorry, qty, driver, phone - self-taken orders (no broker)
  | 'DISPATCH_PARTY_BROKER' // rvp_dispatch_party_broker (document header): buyer, invoice, lorry, qty, driver, phone, broker - buyer copy when a broker exists
  | 'DISPATCH_BROKER' // rvp_dispatch_broker (document header): broker, buyer, invoice, lorry, qty, driver, phone - broker copy
  | 'DISPATCH_DRIVER' // rvp_driver: LOCATION header (buyer's lat/lng) + lorry, party, phone, maps link body
  | 'REMINDER' // rvp_reminder: party, pending lorries, per-PO breakdown
  | 'PAYMENT_REMINDER' // payment_reminder: recipient, outstanding amount, invoice list
  | 'PARTY_LEDGER' // rvp_party_ledger: party, period, opening bal, total debits, total credits, closing bal, recent activity
  | 'OWNER_DISPATCH_REMINDER' // rvp_owner_dispatch: buyer, order, dispatch-by date, order ref
  | 'OWNER_WEEKLY_SUMMARY' // rvp_owner_weekly: date range, seed loads, sale orders, husk orders
  | 'OWNER_DUES_DIGEST'; // rvp_owner_dues: date, total receivable, overdue, top pending

const DEFAULT_TEMPLATE_IDS: Partial<Record<WaTemplateKey, string>> = {
  DISPATCH_PARTY: '26405',
  DISPATCH_PARTY_BROKER: '26406',
  DISPATCH_BROKER: '26407',
  // Recorded for completeness - the driver template goes out over the
  // Meta-format endpoint, which addresses it by name (below), not by this id.
  DISPATCH_DRIVER: '27626',
  OWNER_DISPATCH_REMINDER: '1618894512932537',
  // payment_reminder, approved on the shared KNM number (+917207146094).
  PAYMENT_REMINDER: '26195',
};

function templateId(key: WaTemplateKey): string | undefined {
  return process.env[`FAST2SMS_TMPL_${key}`]?.trim() || DEFAULT_TEMPLATE_IDS[key] || undefined;
}

// Templates sent over the Meta-format POST endpoint (location headers) are
// addressed by their approved NAME, not the numeric message_id above.
const DEFAULT_TEMPLATE_NAMES: Partial<Record<WaTemplateKey, string>> = {
  DISPATCH_DRIVER: 'rvp_driver',
  OWNER_DISPATCH_REMINDER: 'owner_dispatch_reminder',
};

function templateName(key: WaTemplateKey): string | undefined {
  return process.env[`FAST2SMS_TMPL_NAME_${key}`]?.trim() || DEFAULT_TEMPLATE_NAMES[key] || undefined;
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

/** dd-MMM-yyyy, e.g. "17-Jul-2026" - unambiguous for Indian recipients. */
function fmtDate(d: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const { day, month, year } = istCalendar(d);
  return `${String(day).padStart(2, '0')}-${months[month - 1]}-${year}`;
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
        /* malformed JSON - fall through to fallbacks */
      }
    }
    if (numbers.length === 0) push(profile?.ownerWhatsappNumber);
  } catch {
    /* DB unreachable - env fallback below */
  }
  if (numbers.length === 0) push(process.env.WHATSAPP_TEST_NUMBER);
  return numbers;
}

/**
 * Who gets an *internal copy* of a message that just went to a party: the same
 * alert members as above, minus anyone already on the outgoing message (a member
 * whose number is also the party's shouldn't be told twice).
 *
 * `alreadyMessaged` is the raw phone list the party copy went to.
 *
 * In test mode every send is rerouted to the single test number, so N members
 * would land as N identical messages on top of the party's own rerouted copy -
 * one is enough to prove the copy fired, and each extra costs a billed
 * conversation. Never throws.
 */
export async function resolveInternalCopyRecipients(
  alreadyMessaged: Array<string | null | undefined> = []
): Promise<string[]> {
  const sentTo = alreadyMessaged.map(normalizeWhatsAppNumber).filter(Boolean) as string[];
  const targets = (await resolveAlertRecipients()).filter((n) => !sentTo.includes(n));
  const { testMode } = await resolveWhatsAppMode();
  return testMode ? targets.slice(0, 1) : targets;
}

/** Variable values are pipe-joined on the wire - strip pipes (the delimiter) from each while preserving newlines. */
function cleanVar(v: string | number | null | undefined): string {
  const s = (v ?? '')
    .toString()
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\|+/g, ' ')
    .trim();
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
 * Send one approved template. Never throws - the outcome (SENT/FAILED/SKIPPED)
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
    // value - e.g. a Meta phone-number-id - is rejected with "not connected").
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
      // Response may be JSON ({return: true, request_id}) or plain text - keep whatever id we can find.
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

interface LocationSendArgs {
  templateKey: WaTemplateKey;
  to: string | null | undefined;
  location: { lat: number; lng: number; name: string; address: string };
  variables: Array<string | number | null | undefined>;
  relatedType?: string;
  relatedId?: string;
}

/**
 * Send an approved template whose header is a WhatsApp Location component
 * (currently only DISPATCH_DRIVER). Fast2SMS's simple `variables_values` GET
 * send has no way to populate a Location header - Meta only accepts it
 * through the raw Cloud-API-shaped POST endpoint, addressed by the template's
 * NAME (not the numeric message_id) - hence the separate function.
 * Never throws - same SENT/FAILED/SKIPPED contract as sendWhatsAppTemplate.
 */
export async function sendLocationWhatsAppTemplate(
  args: LocationSendArgs,
): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  // Logged in the same shape as the simple send so WhatsAppLog rows read alike.
  const logArgs: SendArgs = {
    templateKey: args.templateKey,
    to: args.to,
    variables: args.variables,
    relatedType: args.relatedType,
    relatedId: args.relatedId,
  };

  const apiKey = process.env.FAST2SMS_API_KEY;
  const phoneNumberId = process.env.FAST2SMS_PHONE_NUMBER_ID;
  const enabled = process.env.WHATSAPP_ENABLED === 'true';
  const { testMode, testNumber } = await resolveWhatsAppMode();

  if (!enabled) {
    await log(logArgs, 'SKIPPED', { error: 'WHATSAPP_ENABLED is not true' });
    return { ok: false, skipped: true, error: 'WhatsApp sending is disabled (WHATSAPP_ENABLED)' };
  }
  if (!apiKey) {
    await log(logArgs, 'SKIPPED', { error: 'FAST2SMS_API_KEY not configured' });
    return { ok: false, skipped: true, error: 'Fast2SMS API key is not configured' };
  }
  if (!phoneNumberId) {
    await log(logArgs, 'SKIPPED', { error: 'FAST2SMS_PHONE_NUMBER_ID not configured - required for location-header templates' });
    return { ok: false, skipped: true, error: 'FAST2SMS_PHONE_NUMBER_ID is not configured (required for location templates)' };
  }
  const name = templateName(args.templateKey);
  if (!name) {
    await log(logArgs, 'SKIPPED', { error: `FAST2SMS_TMPL_NAME_${args.templateKey} is not configured` });
    return { ok: false, skipped: true, error: `Template name for ${args.templateKey} is not configured` };
  }

  const realNumber = normalizeWhatsAppNumber(args.to);
  const targetNumber = testMode ? normalizeWhatsAppNumber(testNumber) : realNumber;
  if (!targetNumber) {
    const error = testMode
      ? 'WHATSAPP_TEST_NUMBER is missing/invalid (test mode is on)'
      : `Recipient phone "${args.to ?? ''}" is missing or not a valid Indian mobile`;
    await log(logArgs, 'FAILED', { phone: realNumber, error });
    return { ok: false, error };
  }

  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: targetNumber,
    type: 'template',
    template: {
      name,
      language: { code: 'en' },
      components: [
        {
          type: 'header',
          parameters: [
            {
              type: 'location',
              location: {
                latitude: args.location.lat,
                longitude: args.location.lng,
                name: cleanVar(args.location.name),
                address: cleanVar(args.location.address),
              },
            },
          ],
        },
        {
          type: 'body',
          parameters: args.variables.map((v) => ({ type: 'text', text: cleanVar(v) })),
        },
      ],
    },
  };

  try {
    const res = await fetch(`${FAST2SMS_URL}/v24.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let providerId: string | undefined;
    try {
      const parsed = JSON.parse(text);
      providerId = parsed.messages?.[0]?.id ?? parsed.request_id ?? undefined;
      if (!res.ok || parsed.error || parsed.status === false) {
        // Meta passthrough errors nest under `error.message`; Fast2SMS's own
        // rejections (e.g. "Template not found.") are a flat {status, message}.
        const error = parsed.error?.message ?? parsed.message ?? `Fast2SMS error ${res.status}`;
        await log(logArgs, 'FAILED', { phone: targetNumber, error: text.slice(0, 500) });
        return { ok: false, error };
      }
    } catch {
      if (!res.ok) {
        await log(logArgs, 'FAILED', { phone: targetNumber, error: `HTTP ${res.status}: ${text.slice(0, 500)}` });
        return { ok: false, error: `Fast2SMS error ${res.status}` };
      }
      /* plain-text success body */
    }
    await log(logArgs, 'SENT', { phone: targetNumber, providerId });
    logger.info(`[whatsapp] ${args.templateKey} (location) sent to ${targetNumber}${testMode ? ' (test mode)' : ''}`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log(logArgs, 'FAILED', { phone: targetNumber, error: msg });
    logger.error(`[whatsapp] ${args.templateKey} (location) send failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Trigger helpers - one per business event. All fire-and-forget safe.
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

/** A prepared message minus its recipient - the party and the office get the identical body. */
type MessageBody = Omit<SendArgs, 'to'>;

/**
 * Send a party message and give the office its own copy of it.
 *
 * The internal members configured in Settings ("Dispatch & alert recipients")
 * receive the very same approved template with the very same wording, media and
 * variables the party got - deliberately a carbon copy rather than a re-worded
 * alert, so the office sees exactly what landed on the party's phone.
 *
 * The returned result is the *party* leg only: the internal copies are a record,
 * never a reason to report the business message as failed. Never throws.
 */
async function sendToPartyAndInternal(
  message: MessageBody,
  partyPhones: Array<string | null | undefined>
): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  const to = partyPhones.filter(Boolean) as string[];
  // No real phone to message (e.g. a broker/expense/Hamali payment with nothing
  // on file) - skip the party leg cleanly instead of logging a FAILED row for a
  // send that was never attempted. The internal copy still always fires below.
  const result = to.length > 0
    ? await sendWhatsAppTemplate({ ...message, to })
    : { ok: false, skipped: true, error: 'No party phone on file' };
  const internal = await resolveInternalCopyRecipients(to);
  await Promise.all(internal.map((number) => sendWhatsAppTemplate({ ...message, to: number })));
  return result;
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
    await sendToPartyAndInternal(
      {
        templateKey: 'PO_CREATED',
        variables: [party.name, poLabel, pos.length, pricePerKg],
        relatedType: 'PO',
        relatedId: pos[0].id,
      },
      [party.phone, party.phone2]
    );
  },

  /** Lorry stocked in → party. */
  async notifyStockIn(stockIn: { id: string; lorryNumber: string; arrivalDate: Date }, po: { poNumber: string | null }, party: { name: string; phone: string | null; phone2?: string | null }) {
    await sendToPartyAndInternal(
      {
        templateKey: 'STOCKIN_CONFIRMED',
        variables: [party.name, stockIn.lorryNumber, po.poNumber ?? '-', fmtDate(stockIn.arrivalDate)],
        relatedType: 'STOCKIN',
        relatedId: stockIn.id,
      },
      [party.phone, party.phone2]
    );
  },

  /**
   * Payment recorded → party. Uses the image-header template with the screenshot
   * when one was uploaded; otherwise falls back to a text-only template so the
   * message still goes out (the image-header template can't send without media).
   */
  async notifyPaymentSent(payment: { id: string; amount: number; date: Date; reference: string | null; screenshotUrl: string | null }, party: { name: string; phone: string | null; phone2?: string | null }) {
    const hasImage = !!payment.screenshotUrl;
    await sendToPartyAndInternal(
      {
        templateKey: hasImage ? 'PAYMENT_SENT' : 'PAYMENT_SENT_TEXT',
        variables: [party.name, fmtInr(payment.amount), fmtDate(payment.date), payment.reference ?? '-'],
        mediaUrl: payment.screenshotUrl ?? undefined,
        relatedType: 'PAYMENT',
        relatedId: payment.id,
      },
      [party.phone, party.phone2]
    );
  },

  /**
   * Receipt recorded (money received) → payer, when we have one on file, plus
   * the internal copy. Unlike Payment, Receipt has no screenshot field, so
   * there's only ever the text template.
   */
  async notifyReceiptReceived(receipt: { id: string; amount: number; date: Date; reference: string | null }, payer: { name: string; phone: string | null; phone2?: string | null }) {
    await sendToPartyAndInternal(
      {
        templateKey: 'RECEIPT_RECEIVED',
        variables: [payer.name, fmtInr(receipt.amount), fmtDate(receipt.date), receipt.reference ?? '-'],
        relatedType: 'RECEIPT',
        relatedId: receipt.id,
      },
      [payer.phone, payer.phone2]
    );
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
    await sendToPartyAndInternal(
      {
        templateKey: 'VERIFICATION_STATEMENT',
        variables: [party.name, details.lorryNumber, fmtWeight(details.netWeightKg), fmtInr(details.amount)],
        mediaUrl: statementPdfUrl,
        documentFilename: statementFilename,
        relatedType: 'VERIFICATION',
        relatedId,
      },
      [party.phone, party.phone2]
    );
  },

  /**
   * Dispatch → driver gets the buyer's name, phone and maps link, plus a real
   * Location header (the approved template requires one) resolved from the
   * buyer's saved Google Maps link. Returns null when no driver phone.
   */
  async notifyDispatchDriver(
    dispatch: { id: string; vehicleNumber: string | null; driverPhone: string | null },
    buyer: { name: string; phone: string | null; locationLink: string | null; address?: string | null; city?: string | null },
  ) {
    if (!dispatch.driverPhone) return null; // no driver captured - nothing to send
    const variables = [dispatch.vehicleNumber ?? '-', buyer.name, buyer.phone ?? '-', buyer.locationLink ?? '-'];

    const point = await resolveLatLngFromMapsLink(buyer.locationLink);
    if (!point) {
      // The template's header is mandatory - without coordinates Meta rejects the
      // whole send (error 132012), so fail loudly here instead of attempting it.
      const error = buyer.locationLink
        ? `Could not resolve GPS coordinates from the buyer's saved maps link (${buyer.locationLink})`
        : `${buyer.name} has no maps link saved - the driver template needs a Location header`;
      await log({ templateKey: 'DISPATCH_DRIVER', to: dispatch.driverPhone, variables, relatedType: 'DISPATCH', relatedId: dispatch.id }, 'FAILED', {
        phone: dispatch.driverPhone,
        error,
      });
      return { ok: false, error };
    }

    return sendLocationWhatsAppTemplate({
      templateKey: 'DISPATCH_DRIVER',
      to: dispatch.driverPhone,
      location: {
        lat: point.lat,
        lng: point.lng,
        name: buyer.name,
        address: [buyer.address, buyer.city].filter(Boolean).join(', ') || buyer.name,
      },
      variables,
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
   * Payment reminder → whoever is being chased. `recipientName` fills the
   * template's greeting, so a broker copy can read "Ravi (for ABC Traders)" and
   * still carry only the invoices that broker stands behind.
   *
   * relatedId is always the BUYER's party id, whoever the copy went to: the daily
   * job throttles off `lastSentAt('PAYMENT_REMINDER', buyerId)`, so a reminder
   * sent by hand from the ledger correctly stops the cron re-nagging for 48h.
   */
  async sendPaymentReminder(args: {
    recipientName: string;
    phones: Array<string | null | undefined>;
    outstanding: number;
    invoiceListText: string;
    buyerId: string;
  }) {
    return sendWhatsAppTemplate({
      templateKey: 'PAYMENT_REMINDER',
      to: args.phones.filter(Boolean) as string[],
      variables: [args.recipientName, fmtInr(args.outstanding), args.invoiceListText],
      relatedType: 'PAYMENT_REMINDER',
      relatedId: args.buyerId,
    });
  },

  /**
   * Sales-dues reminder → buyer. `invoiceListText` is the pre-formatted list of
   * overdue invoices (e.g. "RVP/12 (₹1,20,000) · RVP/15 (₹80,000)"). Fired by the
   * daily job and by the manual "Remind" button on the ledger.
   */
  async sendSalesDuesReminder(buyer: { id: string; name: string; phone: string | null; phone2?: string | null }, outstanding: number, invoiceListText: string) {
    return this.sendPaymentReminder({
      recipientName: buyer.name,
      phones: [buyer.phone, buyer.phone2],
      outstanding,
      invoiceListText,
      buyerId: buyer.id,
    });
  },

  /**
   * Account-statement summary → party, fired by the "WhatsApp Ledger" button on
   * the party ledger. `to` is passed in rather than read off the party because
   * the dialog lets the sender type a one-off number. The seven variables are in
   * the same order as the summary block shown on screen.
   */
  async sendPartyLedgerStatement(
    party: { id: string; name: string },
    to: string | string[] | null | undefined,
    statement: {
      period: string;
      opening: string;
      totalDebit: string;
      totalCredit: string;
      closing: string;
      recentActivity: string;
    },
  ) {
    return sendWhatsAppTemplate({
      templateKey: 'PARTY_LEDGER',
      to,
      variables: [
        party.name,
        statement.period,
        statement.opening,
        statement.totalDebit,
        statement.totalCredit,
        statement.closing,
        statement.recentActivity,
      ],
      relatedType: 'PARTY_LEDGER',
      relatedId: party.id,
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
