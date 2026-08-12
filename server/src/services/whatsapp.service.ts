import type { WaLanguage } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { istCalendar, istParts } from '../lib/istDate.js';
import { coordUrl, mapsUrlFor, resolveLatLngFromMapsLink } from '../lib/mapsLink.js';

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
 *                              number) but REQUIRED for location-header templates,
 *                              which go over the separate Meta-format POST
 *                              endpoint. Do NOT put a Meta phone-number-id here -
 *                              Fast2SMS rejects it.
 *  - WHATSAPP_ENABLED          'true' to send at all (default off, like SLACK_ENABLED)
 *  - WHATSAPP_TEST_MODE        anything but 'false' reroutes to the test number
 *  - WHATSAPP_TEST_NUMBER      where test-mode messages land (owner's phone)
 *  - FAST2SMS_TMPL_<KEY>       numeric Fast2SMS message_id per approved template
 *                              (used by the simple GET send). This is the ENGLISH
 *                              copy - see FAST2SMS_TMPL_<KEY>_<LANG> below.
 *  - FAST2SMS_TMPL_<KEY>_<LANG> the same template's message_id in TE/TA/KN/HI.
 *                              Meta approves one template per language, each with
 *                              its own id; the ERP picks by the party's
 *                              Party.waLanguage and falls back to English when the
 *                              language copy is not configured (or not yet approved).
 *  - FAST2SMS_TMPL_NAME_<KEY>  the template's approved NAME (e.g. driver_industries),
 *                              needed only for templates sent via the Meta-format
 *                              POST endpoint (location headers can't use a numeric
 *                              message_id - Meta's template API wants the name)
 */

const FAST2SMS_URL = 'https://www.fast2sms.com/dev/whatsapp';

/** Template keys - each maps to an approved template's Fast2SMS message_id. */
export type WaTemplateKey =
  | 'PO_CREATED' // rvp_po_created: party, po number(s), lorries, price/kg
  | 'STOCKIN_CONFIRMED' // rvp_stockin_confirmed: party, lorry, party invoice number, date
  | 'VERIFICATION_STATEMENT' // rvp_verification_statement (document header): party, lorry, net weight, amount
  | 'PAYMENT_SENT' // rvp_payment_sent (image header): party, amount, date, reference
  // rvp_payment_sent_text (no header - used when no screenshot): party, amount, date, reference.
  // Its approved BODY must not mention a screenshot: this is the template that goes
  // out precisely when there is no attachment. It also must not share PAYMENT_SENT's
  // message_id - see the guard in notifyPaymentSent.
  | 'PAYMENT_SENT_TEXT'
  | 'RECEIPT_RECEIVED' // rvp_receipt_received: payer, amount, date, reference - Receipt has no screenshot field, text-only
  | 'DISPATCH_PARTY' // rvp_dispatch_party (document header): buyer, invoice, lorry, qty, driver, phone - self-taken orders (no broker)
  | 'DISPATCH_PARTY_BROKER' // rvp_dispatch_party_broker (document header): buyer, invoice, lorry, qty, driver, phone, broker - buyer copy when a broker exists
  | 'DISPATCH_BROKER' // rvp_dispatch_broker (document header): broker, buyer, invoice, lorry, qty, driver, phone - broker copy
  | 'DISPATCH_DRIVER' // driver_industries (LOCATION header - name-addressed POST): driver, lorry, party, destination, load, party phone, maps link
  | 'REMINDER' // rvp_reminder: party, pending lorries, per-PO breakdown
  | 'PAYMENT_REMINDER' // payment_reminder: recipient, outstanding amount, comma-separated invoice list
  | 'PARTY_LEDGER' // rvp_party_ledger (document header - statement PDF): party, period, total debits, total credits, closing bal
  | 'OWNER_DISPATCH_REMINDER' // rvp_owner_dispatch: buyer, order, dispatch-by date, order ref
  | 'OWNER_WEEKLY_SUMMARY' // rvp_owner_weekly: date range + 3 black-seed lorry counts + 4 figures each for pappu and husk
  | 'OWNER_DUES_DIGEST' // rvp_owner_dues: date, total receivable, overdue, top pending
  | 'SUPPORT_TICKET' // rvp_support_ticket (image header - the screen capture): reporter, page, note, time
  // rvp_support_ticket_text (no header) - same four variables, used when the
  // browser couldn't capture the screen. Like PAYMENT_SENT_TEXT, its approved
  // body must NOT mention an attached screenshot, and it must not share
  // SUPPORT_TICKET's message_id (see the guard in notifySupportTicket).
  | 'SUPPORT_TICKET_TEXT';

const DEFAULT_TEMPLATE_IDS: Partial<Record<WaTemplateKey, string>> = {
  DISPATCH_PARTY: '26405',
  DISPATCH_PARTY_BROKER: '26406',
  DISPATCH_BROKER: '26407',
  // DISPATCH_DRIVER is absent on purpose. driver_industries (message_id 28540,
  // approved 2026-08-12) carries a LOCATION header, and a location header can
  // only be filled over the Meta-format POST send, which addresses templates by
  // NAME - see DEFAULT_TEMPLATE_NAMES below and notifyDispatchDriver. An id here
  // would send the body with no header and fail the whole message on Meta's
  // parameter-count check, so FAST2SMS_TMPL_DISPATCH_DRIVER is inert by design.
  // payment_reminder + rvp_owner_dispatch, approved together on the shared KNM
  // number (+917207146094). OWNER_DISPATCH_REMINDER previously carried
  // '1618894512932537' - a *Meta* template id, not a Fast2SMS message_id (those
  // are 5-digit, like these) - and every daily reminder 400'd with "Template ID
  // (message_id) is invalid or not approved". Keep this column Fast2SMS-only.
  PAYMENT_REMINDER: '26195',
  OWNER_DISPATCH_REMINDER: '26196',
  // rvp_owner_dues (4 vars) + rvp_owner_weekly (12 vars), approved 2026-08-11.
  // These two were the last owner templates logging SKIPPED for want of an id.
  OWNER_DUES_DIGEST: '28387',
  OWNER_WEEKLY_SUMMARY: '28393',
  // rvp_support_ticket (image header) + rvp_support_ticket_text (no header),
  // approved 2026-08-11. See the guard in notifySupportTicket - these two must
  // never collapse to the same id.
  SUPPORT_TICKET: '28539',
  SUPPORT_TICKET_TEXT: '28541',
};

/**
 * Non-English message_ids, keyed language → template → id. Every entry here is a
 * SEPARATE approved template on Fast2SMS carrying the same variable slots in the
 * same order as its English twin, so only the id changes at send time.
 *
 * Filled in as Meta approves each translated copy (see
 * docs/whatsapp-multilingual-templates.md for the submitted wording). Anything
 * missing falls back to English rather than skipping the send.
 *
 * The ids run in one near-consecutive block per template, so a transposed digit
 * silently sends a Tamil supplier the Telugu copy - both are valid, approved
 * ids, and nothing errors. `whatsappLanguage.test.ts` pins each one.
 */
const LANGUAGE_TEMPLATE_IDS: Partial<Record<Exclude<WaLanguage, 'EN'>, Partial<Record<WaTemplateKey, string>>>> = {
  // po_* approved 2026-08-11; stockin_* approved 2026-08-12. Both blocks run
  // downwards TE → TA → KN → HI, which is exactly the transposition risk the
  // pinned tests exist for.
  TE: { PO_CREATED: '28599', STOCKIN_CONFIRMED: '28595' },
  TA: { PO_CREATED: '28598', STOCKIN_CONFIRMED: '28594' },
  KN: { PO_CREATED: '28597', STOCKIN_CONFIRMED: '28593' },
  HI: { PO_CREATED: '28596', STOCKIN_CONFIRMED: '28592' },
};

/**
 * The message_id to send `key` on, in `language`.
 *
 * Resolution order, first hit wins:
 *   1. FAST2SMS_TMPL_<KEY>_<LANG>   env override for the language copy
 *   2. LANGUAGE_TEMPLATE_IDS        checked-in id for the language copy
 *   3. FAST2SMS_TMPL_<KEY>          env override for English
 *   4. DEFAULT_TEMPLATE_IDS         checked-in English id
 *
 * The fall-through to English is deliberate: a party marked Tamil must still get
 * their PO confirmation on the day the Tamil template is still in review.
 */
export function templateId(key: WaTemplateKey, language: WaLanguage = 'EN'): string | undefined {
  if (language !== 'EN') {
    const localised =
      process.env[`FAST2SMS_TMPL_${key}_${language}`]?.trim() || LANGUAGE_TEMPLATE_IDS[language]?.[key];
    if (localised) return localised;
  }
  return process.env[`FAST2SMS_TMPL_${key}`]?.trim() || DEFAULT_TEMPLATE_IDS[key] || undefined;
}

/** Which language a send actually went out in, after the English fall-back above. */
export function resolvedLanguage(key: WaTemplateKey, language: WaLanguage = 'EN'): WaLanguage {
  if (language === 'EN') return 'EN';
  const localised =
    process.env[`FAST2SMS_TMPL_${key}_${language}`]?.trim() || LANGUAGE_TEMPLATE_IDS[language]?.[key];
  return localised ? language : 'EN';
}

/**
 * One saleable product's line in the weekly summary. `orders`/`orderedMt` are
 * the week's intake; `dispatchedMt` is what physically left during the week
 * (against any order, new or old); `pendingMt` is the LIVE undelivered balance
 * across every open order - the standing commitment to buyers, not just the
 * unshipped part of this week's intake.
 */
export interface ProductWeekStats {
  orders: number;
  orderedMt: string;
  dispatchedMt: string;
  pendingMt: string;
}

export interface OwnerWeeklyStats {
  seed: { orderedLorries: number; arrivedLorries: number; pendingLorries: number };
  pappu: ProductWeekStats;
  husk: ProductWeekStats;
}

// Templates sent over the Meta-format POST endpoint (location headers) are
// addressed by their approved NAME, not the numeric message_id above. The name
// must match the Fast2SMS panel exactly, and the template must be approved under
// the number FAST2SMS_PHONE_NUMBER_ID points at - a name approved on another of
// the account's numbers 404s with "Template not found." Run the
// /check-driver-template diagnostic (whatsappJobs.ts) when that happens.
const DEFAULT_TEMPLATE_NAMES: Partial<Record<WaTemplateKey, string>> = {
  OWNER_DISPATCH_REMINDER: 'owner_dispatch_reminder',
  DISPATCH_DRIVER: 'driver_industries',
};

function templateName(key: WaTemplateKey): string | undefined {
  return process.env[`FAST2SMS_TMPL_NAME_${key}`]?.trim() || DEFAULT_TEMPLATE_NAMES[key] || undefined;
}

/**
 * The ONE number the deferred-dispatch reminder goes to (Reddy).
 *
 * Deliberately not the Settings alert list, which every other internal alert
 * fans out to. This reminder repeats daily for as long as an order sits
 * undispatched - with the whole list that is 3 billed conversations per order
 * per day, and the open husk backlog alone makes it 21 a day. One recipient
 * keeps it useful instead of spam. Override with WHATSAPP_DISPATCH_REMINDER_NUMBER
 * to redirect it without a deploy.
 */
const DISPATCH_REMINDER_NUMBER = process.env.WHATSAPP_DISPATCH_REMINDER_NUMBER?.trim() || '9440416639';

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
 * The single phone that in-app support tickets go to - the developer's, not the
 * owners'. Support reports are a bug queue, not business news: fanning them out
 * to the alert list put a screenshot of somebody's own mis-click on every
 * owner's phone and billed a conversation per copy. Override with
 * SUPPORT_WHATSAPP_NUMBER if the person on call changes.
 */
export const DEFAULT_SUPPORT_NUMBER = '8019965187';

export function resolveSupportRecipient(): string | null {
  return normalizeWhatsAppNumber(process.env.SUPPORT_WHATSAPP_NUMBER?.trim() || DEFAULT_SUPPORT_NUMBER);
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
  // Recipient's preferred language (Party.waLanguage / Broker.waLanguage).
  // Defaults to English; falls back to English when that language's copy of the
  // template isn't approved yet. Owner/internal-only templates leave it unset.
  language?: WaLanguage | null;
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
        // The language actually used, not the one asked for - a party set to
        // Kannada whose template isn't approved yet logs EN, which is what landed.
        language: resolvedLanguage(args.templateKey, args.language ?? 'EN'),
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
  const messageId = templateId(args.templateKey, args.language ?? 'EN');
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
  /**
   * `name`/`address` are the two caption lines under the pin, and Meta has them
   * optional. Leave them out unless the caption is worth what they cost: with a
   * name and address present, tapping the card hands the map app those STRINGS
   * to look up rather than the coordinates, and a "Plot No.294/10, G.I.D.C"
   * lookup comes back with a list of candidates instead of the gate. Coordinates
   * alone leave nothing to search, so the pin opens where it was dropped.
   */
  location: { lat: number; lng: number; name?: string; address?: string };
  variables: Array<string | number | null | undefined>;
  relatedType?: string;
  relatedId?: string;
}

/**
 * Send an approved template whose header is a WhatsApp Location component.
 * Fast2SMS's simple `variables_values` GET send has no way to populate a
 * Location header - Meta only accepts it through the raw Cloud-API-shaped POST
 * endpoint, addressed by the template's NAME (not the numeric message_id) -
 * hence the separate function.
 *
 * Used by DISPATCH_DRIVER (driver_industries), the one template with a Location
 * header. Meta rejects the send outright if the header parameter is missing, so
 * callers must have real coordinates before reaching here.
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
                // Omitted entirely when unset - an empty string is still a
                // search term to the map app, which is the thing being avoided.
                ...(args.location.name ? { name: cleanVar(args.location.name) } : {}),
                ...(args.location.address ? { address: cleanVar(args.location.address) } : {}),
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
 * receive the very same approved template with the very same media and
 * variables the party got - deliberately a carbon copy rather than a re-worded
 * alert, so the office sees exactly what landed on the party's phone.
 *
 * The one thing the internal copy does NOT mirror is the language: it always
 * goes out in English. The office reads English; a Tamil supplier's confirmation
 * relayed in Tamil is a copy nobody in the office can check. The figures, media
 * and variable values are identical either way.
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
  await Promise.all(internal.map((number) => sendWhatsAppTemplate({ ...message, to: number, language: 'EN' })));
  return result;
}

/**
 * A messageable counterparty. `waLanguage` is optional so a caller that doesn't
 * select it (or a broker/payee that has none) simply gets English - never a
 * missing-field crash on a fire-and-forget notify.
 */
type WaRecipient = {
  name: string;
  phone: string | null;
  phone2?: string | null;
  waLanguage?: WaLanguage | null;
};

export const whatsappService = {
  send: sendWhatsAppTemplate,

  /**
   * PO created → party. One order may split into several per-lorry POs
   * (poGroupId); send a single message covering the group.
   *
   * `tonnageKg` is set only when the order was booked against a weight the party
   * themselves quoted, and the operator ticked "Send tonnage in message". The
   * approved template's third slot sits after the static label "Lorries:", so the
   * weight goes in brackets *after* the count - "2 (50,000 KGS)" - which keeps the
   * label truthful. Never replace the count with the weight: the party would read
   * "Lorries: 50,000 KGS".
   */
  async notifyPoCreated(
    pos: Array<{ id: string; poNumber: string | null }>,
    party: WaRecipient,
    pricePerKg: number,
    tonnageKg?: number | null
  ) {
    if (pos.length === 0) return;
    const first = pos[0].poNumber ?? '';
    const last = pos[pos.length - 1].poNumber ?? '';
    const poLabel = pos.length === 1 ? first : `${first} to ${last}`;
    const lorryLabel =
      tonnageKg && tonnageKg > 0 ? `${pos.length} (${fmtInr(tonnageKg)} KGS)` : String(pos.length);
    await sendToPartyAndInternal(
      {
        templateKey: 'PO_CREATED',
        language: party.waLanguage,
        variables: [party.name, poLabel, lorryLabel, pricePerKg],
        relatedType: 'PO',
        relatedId: pos[0].id,
      },
      [party.phone, party.phone2]
    );
  },

  /**
   * Lorry stocked in → party. The template's third slot is the party's OWN
   * invoice number (as typed at stock-in), not our PO number - fall back to the
   * PO number only when the arrival was recorded without one.
   */
  async notifyStockIn(
    stockIn: { id: string; lorryNumber: string; arrivalDate: Date; invoiceNumber?: string | null },
    po: { poNumber: string | null },
    party: WaRecipient
  ) {
    const invoiceLabel = stockIn.invoiceNumber?.trim() || po.poNumber || '-';
    await sendToPartyAndInternal(
      {
        templateKey: 'STOCKIN_CONFIRMED',
        language: party.waLanguage,
        variables: [party.name, stockIn.lorryNumber, invoiceLabel, fmtDate(stockIn.arrivalDate)],
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
   *
   * If a no-screenshot payment still reaches the party saying a screenshot is
   * attached, the branch below is not the cause - check the two ids. When both
   * FAST2SMS_TMPL_* vars carry the same message_id, every payment sends on the
   * image template's approved copy; that misconfiguration is warned about here.
   * If the ids differ, the wrong wording is baked into rvp_payment_sent_text's
   * own approved body and has to be corrected in the Fast2SMS panel.
   */
  async notifyPaymentSent(payment: { id: string; amount: number; date: Date; reference: string | null; screenshotUrl: string | null }, party: WaRecipient) {
    const hasImage = !!payment.screenshotUrl;
    const lang = party.waLanguage ?? 'EN';
    if (!hasImage && templateId('PAYMENT_SENT_TEXT', lang) && templateId('PAYMENT_SENT_TEXT', lang) === templateId('PAYMENT_SENT', lang)) {
      logger.error(
        `[whatsapp] the PAYMENT_SENT_TEXT and PAYMENT_SENT ${lang} templates hold the same message_id ` +
          `(${templateId('PAYMENT_SENT', lang)}) - this payment has no screenshot but will send on the image template's copy`
      );
    }
    await sendToPartyAndInternal(
      {
        templateKey: hasImage ? 'PAYMENT_SENT' : 'PAYMENT_SENT_TEXT',
        language: party.waLanguage,
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
  async notifyReceiptReceived(receipt: { id: string; amount: number; date: Date; reference: string | null }, payer: WaRecipient) {
    await sendToPartyAndInternal(
      {
        templateKey: 'RECEIPT_RECEIVED',
        language: payer.waLanguage,
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
    party: WaRecipient & { id?: string },
    details: { lorryNumber: string; netWeightKg: number; amount: number },
    statementPdfUrl: string | undefined,
    statementFilename: string | undefined,
    relatedId: string
  ) {
    await sendToPartyAndInternal(
      {
        templateKey: 'VERIFICATION_STATEMENT',
        language: party.waLanguage,
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
   * Dispatch → driver, in the seven slots of the approved driver_industries
   * template: driver, lorry, buyer, destination, load, buyer's phone, maps link.
   * Returns null when no driver phone was captured.
   *
   * driver_industries carries a LOCATION HEADER - the pin card above the text -
   * so it goes over the Meta-format POST send addressed by template NAME, not
   * the numeric message_id GET send every other template uses. Meta requires the
   * header's latitude/longitude on every send: there is no way to send this
   * template without a pin, and no id-based fallback, because the plain-text
   * driver template it replaced was deleted.
   *
   * Hence the hard requirement below. Coordinates come from the buyer's saved
   * location (see resolveLatLngFromMapsLink) - a maps link that spells them out,
   * a short link whose redirect does, or plain "lat,lng" typed into the field.
   * A buyer whose link resolves to nothing is SKIPPED with that spelled out,
   * rather than sent a message with a pin invented from their city: a driver
   * following a wrong pin is worse off than one who got no message at all.
   *
   * Destination is still spelled out in {{4}} rather than left to the pin, and
   * a link still goes in {{7}} - shortened to `?q=lat,lng` from whatever was
   * pasted into the party form: the pin card is easy to scroll past, and a
   * driver who has the text can read the town name out to someone.
   *
   * The name is the one slot that can't fall back to "-": it opens the greeting,
   * and "Namaste - " reads as a broken message rather than a missing field.
   */
  async notifyDispatchDriver(
    dispatch: {
      id: string;
      vehicleNumber: string | null;
      driverName: string | null;
      driverPhone: string | null;
      weightKg: number | null;
    },
    buyer: { name: string; phone: string | null; locationLink: string | null; address?: string | null; city?: string | null },
    order: { destination: string | null; product: string },
  ) {
    if (!dispatch.driverPhone) return null; // no driver captured - nothing to send
    const destination = order.destination?.trim() || buyer.city?.trim() || '-';
    const load =
      dispatch.weightKg != null ? `${order.product} - ${fmtWeight(dispatch.weightKg)}` : order.product;
    const coords = await resolveLatLngFromMapsLink(buyer.locationLink);
    const variables = [
      dispatch.driverName?.trim() || 'Driver ji',
      dispatch.vehicleNumber ?? '-',
      buyer.name,
      destination,
      load,
      buyer.phone ?? '-',
      // Once the coordinates are known, {{7}} is rebuilt as a short `?q=lat,lng`
      // link rather than echoing what is stored: a copied Google Maps place URL
      // runs 300-odd characters and wrapped over eight lines in the driver's
      // message, pushing the lorry and load details out of his first screen.
      (coords ? coordUrl(coords) : mapsUrlFor(buyer.locationLink)) ?? '-',
    ];

    if (!coords) {
      const error = buyer.locationLink?.trim()
        ? `Could not read coordinates from ${buyer.name}'s saved maps link - the driver template needs a pin. ` +
          `Open the pin in Google Maps, copy the "lat, lng" numbers and paste those into the party's location field.`
        : `${buyer.name} has no maps location on file - the driver template needs a pin to send.`;
      await log(
        {
          templateKey: 'DISPATCH_DRIVER',
          to: dispatch.driverPhone,
          variables,
          relatedType: 'DISPATCH',
          relatedId: dispatch.id,
        },
        'SKIPPED',
        { phone: normalizeWhatsAppNumber(dispatch.driverPhone), error },
      );
      logger.warn(`[whatsapp] DISPATCH_DRIVER skipped for dispatch ${dispatch.id}: ${error}`);
      return { ok: false, skipped: true, error };
    }

    return sendLocationWhatsAppTemplate({
      templateKey: 'DISPATCH_DRIVER',
      to: dispatch.driverPhone,
      // Coordinates only, no name or address: those two caption lines turn the
      // driver's tap on the pin into a text search - the first live send showed
      // a list of Pandesara GIDC candidates instead of the buyer's gate. He
      // loses nothing by their absence, since {{3}} and {{4}} directly below
      // name the buyer and the town.
      location: { lat: coords.lat, lng: coords.lng },
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

  /**
   * Pending-loads reminder → party (manual button on the Party Ledger). The
   * office gets its own copy: someone pressing "Remind" from the ledger is
   * chasing a supplier on the firm's behalf, and the owners want the same
   * message on their phone rather than having to open the log to see it went.
   */
  async sendReminder(party: WaRecipient & { id: string }, pendingLorries: number, poLabel: string) {
    return sendToPartyAndInternal(
      {
        templateKey: 'REMINDER',
        language: party.waLanguage,
        variables: [party.name, pendingLorries, poLabel],
        relatedType: 'REMINDER',
        relatedId: party.id,
      },
      [party.phone, party.phone2]
    );
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
    /** Comma-separated, one variable - Meta forbids newlines inside a parameter. */
    invoiceListText: string;
    buyerId: string;
    /** The RECIPIENT's language - the broker's own when this is the broker copy, not the buyer's. */
    language?: WaLanguage | null;
    /**
     * Copy the office on this reminder. Opt-in, and set only by the Party Ledger
     * button: the nightly dues job would otherwise bill an internal conversation
     * per overdue buyer per member, every night, on top of the single
     * OWNER_DUES_DIGEST that already tells the owners the same thing.
     */
    internalCopy?: boolean;
  }) {
    const message: MessageBody = {
      templateKey: 'PAYMENT_REMINDER',
      language: args.language,
      variables: [args.recipientName, fmtInr(args.outstanding), args.invoiceListText],
      relatedType: 'PAYMENT_REMINDER',
      relatedId: args.buyerId,
    };
    return args.internalCopy
      ? sendToPartyAndInternal(message, args.phones)
      : sendWhatsAppTemplate({ ...message, to: args.phones.filter(Boolean) as string[] });
  },

  /**
   * Sales-dues reminder → buyer. `invoiceListText` is the pre-formatted list of
   * overdue invoices (e.g. "RVP/12 (₹1,20,000) · RVP/15 (₹80,000)"). Fired by the
   * daily job and by the manual "Remind" button on the ledger.
   */
  async sendSalesDuesReminder(buyer: WaRecipient & { id: string }, outstanding: number, invoiceListText: string) {
    return this.sendPaymentReminder({
      recipientName: buyer.name,
      phones: [buyer.phone, buyer.phone2],
      outstanding,
      invoiceListText,
      buyerId: buyer.id,
      language: buyer.waLanguage,
    });
  },

  /**
   * Account statement → party, fired by the "WhatsApp Ledger" button on the party
   * ledger: the full statement rides along as a PDF document header, so the body
   * carries only the five-figure summary. `to` is passed in rather than read off
   * the party because the dialog lets the sender type a one-off number.
   *
   * The document is mandatory - the approved template has a document header, and
   * Meta rejects the send outright if the media is missing. Opening balance and
   * the transaction rows live in the PDF, deliberately not in the body: template
   * variables cannot contain newlines.
   *
   * The office is copied on the same statement PDF, so the owners hold a record
   * of exactly which figures went out to which party on which day.
   */
  async sendPartyLedgerStatement(
    party: { id: string; name: string },
    to: string | string[] | null | undefined,
    statement: {
      period: string;
      totalDebit: string;
      totalCredit: string;
      closing: string;
    },
    document: { url: string; filename: string },
  ) {
    return sendToPartyAndInternal(
      {
        templateKey: 'PARTY_LEDGER',
        variables: [
          party.name,
          statement.period,
          statement.totalDebit,
          statement.totalCredit,
          statement.closing,
        ],
        mediaUrl: document.url,
        documentFilename: document.filename,
        relatedType: 'PARTY_LEDGER',
        relatedId: party.id,
      },
      Array.isArray(to) ? to : [to]
    );
  },

  /**
   * Owner alert: an advance sale order's dispatch date has arrived but it is not
   * yet dispatched. Goes to ONE person, NOT the buyer and NOT the whole alert
   * list - see DISPATCH_REMINDER_NUMBER.
   */
  async notifyOwnerDispatch(order: { id: string; buyerName: string; orderSummary: string; dispatchBy: Date; ref: string }) {
    return sendWhatsAppTemplate({
      templateKey: 'OWNER_DISPATCH_REMINDER',
      to: DISPATCH_REMINDER_NUMBER,
      variables: [order.buyerName, order.orderSummary, fmtDate(order.dispatchBy), order.ref],
      relatedType: 'OWNER_DISPATCH_REMINDER',
      relatedId: order.id,
    });
  },

  /**
   * Owner weekly business summary. Twelve variables, in template order: the date
   * range, three black-seed lorry counts, then four figures each for pappu and
   * husk. Tonnages arrive pre-formatted to 2dp as plain MT numbers - the unit
   * lives in the approved template text, not in the value, so re-wording the
   * message never needs a code change.
   */
  async sendOwnerWeeklySummary(range: string, stats: OwnerWeeklyStats, weekKey: string) {
    return fanOutToAlertRecipients((to) =>
      sendWhatsAppTemplate({
        templateKey: 'OWNER_WEEKLY_SUMMARY',
        to,
        variables: [
          range,
          stats.seed.orderedLorries,
          stats.seed.arrivedLorries,
          stats.seed.pendingLorries,
          stats.pappu.orders,
          stats.pappu.orderedMt,
          stats.pappu.dispatchedMt,
          stats.pappu.pendingMt,
          stats.husk.orders,
          stats.husk.orderedMt,
          stats.husk.dispatchedMt,
          stats.husk.pendingMt,
        ],
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

  /**
   * In-app support request → the alert recipients. The screen capture rides as
   * the image header when the browser managed to take one; otherwise the
   * text-only twin goes out so a report is never lost over a failed capture.
   *
   * Unlike every other helper here this one RETURNS its result to the caller
   * rather than being fired and forgotten: the reporter is standing at the
   * dialog waiting to be told their issue was received, and "sent" vs "saved
   * but not sent" is the difference between them walking away and them calling
   * you anyway. The ticket row is written first regardless, so a WhatsApp
   * outage still leaves the evidence on the /support page.
   */
  async notifySupportTicket(ticket: {
    id: string;
    userName: string;
    userRole: string;
    pageLabel: string;
    pagePath: string;
    note: string;
    screenshotUrl: string | null;
    createdAt: Date;
  }) {
    const hasImage = !!ticket.screenshotUrl;
    if (!hasImage && templateId('SUPPORT_TICKET_TEXT') && templateId('SUPPORT_TICKET_TEXT') === templateId('SUPPORT_TICKET')) {
      logger.error(
        '[whatsapp] FAST2SMS_TMPL_SUPPORT_TICKET_TEXT and FAST2SMS_TMPL_SUPPORT_TICKET hold the same message_id ' +
          `(${templateId('SUPPORT_TICKET')}) - this ticket has no screenshot but will send on the image template's copy`
      );
    }
    // Page reads as "Purchase Orders (/purchases/orders)" so the exact route is
    // there to reproduce from, not just the friendly label.
    const page = ticket.pageLabel === ticket.pagePath ? ticket.pagePath : `${ticket.pageLabel} (${ticket.pagePath})`;
    // "11-Aug-2026 04:35 PM" - IST, because Render's clock is UTC.
    const t = istParts(ticket.createdAt);
    const when = `${fmtDate(ticket.createdAt)} ${t.hour}:${t.minute} ${t.ampm}`;
    // The note comes from a free-text textarea, so it WILL contain the Enter key.
    // Meta forbids a newline inside a template variable: Fast2SMS accepts the
    // send and logs a provider id, then WhatsApp drops the message undelivered
    // (see docs/whatsapp-payment-reminder-templates.md). Collapse to a separator
    // rather than stripping, so the reporter's own line breaks still read as
    // breaks in their sentence.
    const note = ticket.note.replace(/\s*\n+\s*/g, ' · ').trim();
    // Support goes to ONE phone - the developer's - never the alert fan-out. An
    // owner cannot act on a stack trace, and each extra copy is a billed
    // conversation carrying a screenshot of a colleague's mistake.
    const to = resolveSupportRecipient();
    if (!to) return { ok: false, skipped: true, error: 'No support recipient configured' };
    return sendWhatsAppTemplate({
      templateKey: hasImage ? 'SUPPORT_TICKET' : 'SUPPORT_TICKET_TEXT',
      to,
      variables: [`${ticket.userName} (${ticket.userRole})`, page, note, when],
      mediaUrl: ticket.screenshotUrl ?? undefined,
      relatedType: 'SUPPORT_TICKET',
      relatedId: ticket.id,
    });
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
