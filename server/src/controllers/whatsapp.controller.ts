import type { Request, Response } from 'express';
import type { WaDelivery, WaLanguage } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { logger } from '../lib/logger.js';
import {
  whatsappService,
  normalizeWhatsAppNumber,
  downloadWhatsAppMedia,
  notifyDriverKataReceived,
  notifyDriverKataConfirmed,
  notifyDriverKataRejected,
  notifyOwnersKataReceived,
  notifyInboundMessageToMembers,
  resolveAlertRecipients,
  sendSessionTextMessage,
} from '../services/whatsapp.service.js';
import { parseTransportConfirmationText, parseBuyerKataImage } from '../lib/gemini.js';
import type { ParsedBuyerKata, ParsedTransportConfirmation } from '../lib/gemini.js';
import { parseLorryCode } from '../lib/lorryCode.js';
import { parseBookingReplies } from '../lib/bookingReply.js';
import { flatTripFreight } from '../lib/transportFreight.js';
import { bookingRoute, DEFAULT_HOME_PLACE } from '../lib/bookingRoute.js';
import { ACTIVE_SLOT_STATUSES } from '../services/dispatchSlot.service.js';
import { sendDispatchBundleWhatsApp, resendDispatchDriverWhatsApp } from '../services/dispatchWhatsapp.service.js';
import {
  normalizeLorryNumber,
  findWaitingConfirmation,
  WAITING_STATES,
  USED_STATES,
} from '../services/lorryConfirmation.service.js';
import { JOB_RUNNERS, OWNER_DIGEST_JOBS, describeCron, buildCron, rescheduleOwnerJob, reschedulePartyDueTodayJob } from '../jobs/whatsappJobs.js';
import { buildPartyStatementData } from './ledger.controller.js';
import { findCompanyVehicle, clean10DigitPhone } from '../lib/calc.js';
import { getCompanyProfileRow } from './settings.controller.js';
import { renderStatementPdf } from '../lib/statementPdf.js';
import { renderBrokerLedgerPdf } from '../lib/brokerLedgerPdf.js';
import { buildBrokerLedgerData, isOwnBroker } from '../services/brokerLedger.service.js';
import { uploadFileToStorage, uploadBufferToStorage } from '../lib/upload.js';
import { computeBuyerDues, computePartyDues, invoiceListText } from '../services/salesDues.service.js';
import { duesScope, runPartyPaymentReminderCore } from '../services/partyReminder.service.js';
import { confirmDelivery } from '../services/delivery.service.js';

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
interface ExtractedInbound {
  from: string | null;
  text: string | null;
  mediaUrl: string | null;
  mediaId: string | null;
  mediaType: string | null;
}

/**
 * Pull the sender + message text + any attached media out of a Fast2SMS webhook payload.
 * Probe common BSP and Meta Cloud API payload fields.
 */
function extractInbound(body: unknown): ExtractedInbound {
  if (!body || typeof body !== 'object') {
    return { from: null, text: null, mediaUrl: null, mediaId: null, mediaType: null };
  }
  const b = body as Record<string, unknown>;
  const containers = [b, b.data, b.message, b.payload].filter(
    (x): x is Record<string, unknown> => !!x && typeof x === 'object'
  );

  // Meta Direct envelope: entry[].changes[].value.messages[]
  if (Array.isArray(b.entry)) {
    for (const entry of b.entry) {
      const changes = asRecord(entry)?.changes;
      if (!Array.isArray(changes)) continue;
      for (const change of changes) {
        const val = asRecord(asRecord(change)?.value);
        if (val) {
          containers.push(val);
          if (Array.isArray(val.messages)) {
            for (const m of val.messages) {
              if (m && typeof m === 'object') containers.push(m as Record<string, unknown>);
            }
          }
        }
      }
    }
  }

  let from: string | null = null;
  let text: string | null = null;
  let mediaUrl: string | null = null;
  let mediaId: string | null = null;
  let mediaType: string | null = null;

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

    // Direct media URL fields
    for (const key of ['media_url', 'mediaUrl', 'url', 'image_url', 'file_url']) {
      const v = c[key];
      if (!mediaUrl && typeof v === 'string' && v.trim().startsWith('http')) {
        mediaUrl = v.trim();
      }
    }

    // Fast2SMS chat_uploads or direct image links in text/body
    if (!mediaUrl && text && /^https?:\/\//i.test(text)) {
      if (/\.(jpe?g|png|webp|gif|pdf)(\?.*)?$/i.test(text) || text.includes('chat_uploads') || text.includes('fast2sms.com')) {
        mediaUrl = text;
        if (!mediaType) {
          mediaType = text.includes('.pdf') ? 'application/pdf' : 'image/jpeg';
        }
      }
    }

    // Media ID fields (Meta Cloud API / Fast2SMS media asset IDs)
    for (const key of ['media_id', 'mediaId']) {
      const v = c[key];
      if (!mediaId && (typeof v === 'string' || typeof v === 'number') && String(v).trim()) {
        mediaId = String(v).trim();
      }
    }

    for (const key of ['media_type', 'mediaType', 'mime_type', 'mimetype', 'type']) {
      const v = c[key];
      if (!mediaType && typeof v === 'string' && v.trim()) {
        mediaType = v.trim();
      }
    }

    // Meta object style: { image: { id, mime_type, sha256, caption }, type: 'image' }
    // or { document: { id, filename, mime_type } }
    for (const mediaKey of ['image', 'document', 'media']) {
      const mediaObj = c[mediaKey];
      if (mediaObj && typeof mediaObj === 'object') {
        const m = mediaObj as Record<string, unknown>;
        if (!mediaId && m.id) mediaId = String(m.id);
        if (!mediaUrl && typeof m.link === 'string') mediaUrl = m.link;
        if (!mediaUrl && typeof m.url === 'string') mediaUrl = m.url;
        if (!mediaType && typeof m.mime_type === 'string') mediaType = m.mime_type;
        if (!text && typeof m.caption === 'string' && m.caption.trim()) text = m.caption.trim();
      }
    }
  }
  return { from, text, mediaUrl, mediaId, mediaType };
}

/** Fast2SMS's `message_id` (a Meta `wamid.…`), used to drop retried deliveries. */
function extractMessageId(body: unknown): string | null {
  const r = asRecord(body);
  if (!r) return null;
  for (const key of ['message_id', 'messageId', 'request_id', 'requestId']) {
    const v = r[key];
    if ((typeof v === 'string' || typeof v === 'number') && String(v).trim()) return String(v).trim();
  }

  // Meta envelope: entry[].changes[].value.messages[0].id
  if (Array.isArray(r.entry)) {
    for (const entry of r.entry) {
      const changes = asRecord(entry)?.changes;
      if (!Array.isArray(changes)) continue;
      for (const change of changes) {
        const val = asRecord(asRecord(change)?.value);
        if (Array.isArray(val?.messages) && val?.messages[0]?.id) {
          return String(val.messages[0].id);
        }
      }
    }
  }

  return null;
}

export interface InboundLogRow {
  id: string;
  from: string | null;
  text: string | null;
  mediaUrl: string | null;
  mediaId: string | null;
  mediaType: string | null;
}

/**
 * Persist an inbound message. Runs BEFORE the webhook is acknowledged, so a
 * restart between the ACK and this write can't lose a transporter's message.
 *
 * Returns null when the payload is a retry we've already filed. Throws on a
 * database failure - the caller turns that into a non-2xx so Fast2SMS retries
 * rather than dropping the message on the floor.
 */
async function recordInboundMessage(rawBody: unknown): Promise<InboundLogRow | null> {
  const { from, text, mediaUrl, mediaId, mediaType } = extractInbound(rawBody);
  const body = text ?? JSON.stringify(rawBody).slice(0, 4000);

  // Fast2SMS retries a webhook up to 3 times, 60s apart, whenever our response
  // wasn't a 2xx - so the same message can legitimately arrive more than once.
  // Without this, one retried transporter message becomes two DRAFT rows, and
  // confirming both would apply the freight twice.
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
    data: {
      direction: 'INBOUND',
      phone: from,
      body,
      mediaUrl: mediaUrl || mediaId || null,
      mediaType: mediaType || null,
      status: 'RECEIVED',
      providerId: messageId,
    },
  });
  return { id: logRow.id, from, text, mediaUrl, mediaId, mediaType };
}

/**
 * Check if an inbound WhatsApp message is from a driver with an active DISPATCHED trip,
 * and if so, processes their buyer kata slip image.
 * Returns true if handled as a driver kata submission, false otherwise.
 */
async function processDriverKataInbound(logRow: InboundLogRow): Promise<boolean> {
  const from = logRow.from;
  if (!from) return false;

  const phoneDigits = from.replace(/\D/g, '').slice(-10);
  if (phoneDigits.length < 10) return false;

  const mediaSource = logRow.mediaUrl || logRow.mediaId || (logRow.text && /^https?:\/\//i.test(logRow.text) ? logRow.text : null);
  if (!mediaSource) return false;

  // 1. Primary match: the trip whose driver is this sender. It needs nothing
  //    read off the image, so do it BEFORE the network work - if the download
  //    or the OCR then fails, the slip is still filed against the right lorry
  //    instead of falling through to "just another photo" and disappearing.
  let dispatch = await prisma.saleDispatch.findFirst({
    where: {
      status: 'DISPATCHED',
      driverPhone: { contains: phoneDigits },
    },
    orderBy: { dispatchDate: 'desc' },
    include: {
      saleOrder: { include: { buyer: true } },
    },
  });

  // 2. Download image
  const downloaded = await downloadWhatsAppMedia(mediaSource);
  if (!downloaded) {
    logger.error(`[whatsapp] could not download kata media from ${mediaSource}`);
    if (!dispatch) return false;
    // Nothing could be read, so file it against the driver's own trip with the
    // sender's original link and no OCR, and let a human key the weight in.
    // That is what was happening anyway while this path returned false - only
    // with no row, no alert and no trace that a slip had ever arrived.
    await fileKataSubmission({ dispatch, from, parsed: null, imageUrl: mediaSource });
    return true;
  }

  // 3. Run Gemini OCR
  logger.info(`[whatsapp] running Gemini OCR on media from ${from}...`);
  const parsed = await parseBuyerKataImage(downloaded.buffer, downloaded.mimeType);

  // 4. Secondary: if the phone didn't match, go by the lorry number on the slip.
  //    No longer gated on isBuyerKataSlip - the model reads a registration
  //    number off a photo it is unsure about often enough, and a number that
  //    matches a live dispatch is evidence enough on its own. Most slips reach
  //    us forwarded from the office or the transporter, not from the number in
  //    driverPhone, so this is the path that actually carries the traffic.
  if (!dispatch && parsed?.lorryNumber) {
    const cleanLorry = parsed.lorryNumber.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const lorrySuffix = cleanLorry.slice(-4);
    logger.info(`[whatsapp] matching active dispatch for lorry ${cleanLorry} (suffix ${lorrySuffix})...`);

    const activeDispatches = await prisma.saleDispatch.findMany({
      where: { status: 'DISPATCHED' },
      orderBy: { dispatchDate: 'desc' },
      take: 20,
      include: {
        saleOrder: { include: { buyer: true } },
      },
    });

    dispatch =
      activeDispatches.find((cand) => {
        const v = (cand.vehicleNumber || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
        return (
          v.includes(cleanLorry) ||
          cleanLorry.includes(v) ||
          (lorrySuffix.length === 4 && v.endsWith(lorrySuffix))
        );
      }) || null;

    // Tertiary: If still no active DISPATCHED trip, fall back to recent dispatches (e.g. testing or already delivered)
    if (!dispatch) {
      const recentDispatches = await prisma.saleDispatch.findMany({
        orderBy: { createdAt: 'desc' },
        take: 30,
        include: {
          saleOrder: { include: { buyer: true } },
        },
      });
      dispatch =
        recentDispatches.find((cand) => {
          const v = (cand.vehicleNumber || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
          return (
            v.includes(cleanLorry) ||
            cleanLorry.includes(v) ||
            (lorrySuffix.length === 4 && v.endsWith(lorrySuffix))
          );
        }) || null;
    }
  }

  // If no dispatch was matched:
  if (!dispatch) {
    if (parsed?.isBuyerKataSlip || parsed?.lorryNumber) {
      logger.warn(`[whatsapp] kata slip detected from ${from} for lorry ${parsed.lorryNumber} (${parsed.buyerKataKg} kg) but no matching dispatch found`);

      // 1. Notify Owners / Alert recipients on WhatsApp
      resolveAlertRecipients()
        .then((recipients) => {
          const alertText =
            `⚠️ *Buyer Weighbridge Slip Received (No Dispatch Match)*\n\n` +
            `• Sender: +${from}\n` +
            `• Lorry on Slip: *${parsed.lorryNumber || 'Unknown'}*\n` +
            `• Net Weight: *${parsed.buyerKataKg ? `${parsed.buyerKataKg.toLocaleString('en-IN')} kg` : 'N/A'}*\n` +
            `• Mill / Weighbridge: ${parsed.buyerName || 'N/A'}\n\n` +
            `_Could not link to an active dispatch in ERP. Please verify manually._`;
          return Promise.all(
            recipients.map((phone) =>
              sendSessionTextMessage({ to: phone, text: alertText, relatedType: 'KATA_UNMATCHED' })
            )
          );
        })
        .catch((err) => {
          logger.error('[whatsapp] failed to notify owners of unmatched kata slip', err);
        });
      return true;
    }
    return false;
  }

  // 5. Keep our own copy of the image, then file it. A failed upload is not a
  //    reason to lose the slip - fall back to the sender's own link, which is
  //    at least readable while someone looks at the row.
  const ext = downloaded.mimeType.includes('pdf') ? '.pdf' : '.jpg';
  let imageUrl = mediaSource;
  try {
    imageUrl = await uploadBufferToStorage(downloaded.buffer, downloaded.mimeType, ext);
  } catch (uploadErr) {
    logger.error('[whatsapp] failed to upload kata slip to storage - keeping the sender link', uploadErr);
  }

  await fileKataSubmission({ dispatch, from, parsed, imageUrl });
  return true;
}

type KataDispatch = Prisma.SaleDispatchGetPayload<{
  include: { saleOrder: { include: { buyer: true } } };
}>;

/**
 * Record a matched kata slip and tell everyone who needs to know: the driver
 * gets an acknowledgement, the owners get the shortage. Split out of the
 * matching above so the paths where nothing could be
 * read off the image - a download that failed, an OCR that came back empty -
 * can still file the slip against the trip instead of dropping it.
 */
async function fileKataSubmission(args: {
  dispatch: KataDispatch;
  from: string;
  parsed: ParsedBuyerKata | null;
  imageUrl: string;
}): Promise<void> {
  const { dispatch, from, parsed, imageUrl: publicUrl } = args;

  const submission = await prisma.driverKataSubmission.create({
    data: {
      saleDispatchId: dispatch.id,
      driverPhone: from,
      imageUrl: publicUrl,
      rawOcrResult: parsed?.rawResponse ?? (parsed as any) ?? Prisma.JsonNull,
      ocrBuyerKataKg: parsed?.buyerKataKg ?? null,
      ocrLorryNumber: parsed?.lorryNumber ?? null,
      ocrBuyerName: parsed?.buyerName ?? null,
      status: 'PENDING',
    },
  });

  // 6. Send acknowledgment reply to driver
  const lorryNo = dispatch.vehicleNumber || parsed?.lorryNumber || 'your lorry';
  notifyDriverKataReceived(from, lorryNo).catch((err) => {
    logger.error('[whatsapp] driver ack reply failed', err);
  });

  // 7. Notify Owners / Alert recipients on WhatsApp
  const dispatchedKg = dispatch.weightKg;
  const kataKg = parsed?.buyerKataKg ?? 0;
  const shortageKg = kataKg > 0 ? Math.max(0, dispatchedKg - kataKg) : 0;
  const shortagePct = dispatchedKg > 0 && shortageKg > 0 ? ((shortageKg / dispatchedKg) * 100).toFixed(2) : '0';

  notifyOwnersKataReceived({
    submissionId: submission.id,
    lorryNumber: dispatch.vehicleNumber || parsed?.lorryNumber || 'Unknown',
    driverPhone: from,
    buyerName: dispatch.saleOrder.buyer.name,
    product: dispatch.saleOrder.product,
    dispatchedKg,
    buyerKataKg: parsed?.buyerKataKg ?? null,
    shortageKg,
    shortagePct,
    imageUrl: publicUrl,
  }).catch((err) => {
    logger.error('[whatsapp] failed to notify owners of driver kata', err);
  });

  logger.info(`[whatsapp] DriverKataSubmission ${submission.id} created for dispatch ${dispatch.id}`);
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
async function parseInboundIntoRegister(logRow: InboundLogRow): Promise<boolean> {
  const { from, text } = logRow;

  // A transport confirmation is a long-ish text with digits (lorry no / phone).
  if (!text || text.length < 25 || !/\d{4}/.test(text)) return false;

  // A photo, voice note or PDF is not a booking message. When one arrives,
  // extractInbound leaves the media's own URL in `text` - and that URL's digits
  // ("…/1674492334027097.jpg") read enough like a lorry number and a date that
  // Gemini will happily return the example from its own prompt. Every such
  // message used to file a phantom booking, which is where the register's
  // repeated "18 Jul 2026 / AP39T8217 / Moula" rows came from. There is nothing
  // to read in a bare link, so stop before the model is asked.
  if (logRow.mediaUrl || logRow.mediaId) return false;
  if (/^https?:\/\/\S*$/i.test(text.trim())) return false;

  // Never treat owner commands or delivery review replies as lorry transport bookings
  if (/^(?:APPROVE|REJECT|DELIVER|CONFIRM|STATUS|CHECK|HELP|KATA)\b/i.test(text.trim())) return false;
  if (/\b(?:override\s*weight|confirm\s*delivery|kata\s*slip|kata\s*received)\b/i.test(text)) return false;

  // The reply shape this ERP hands out (code / lorry / mobile / MT / place) is
  // read deterministically; only free-written broker messages go to the model,
  // whose prompt knows the sentence form and answers inconsistently on the
  // terse one. See lib/bookingReply.ts.
  //
  // A day's indent lists the whole fleet, so one reply can answer for several
  // codes. Each block is filed as its own booking against its own code - the
  // alternative, reading only the first, loses the rest of the day's lorries
  // without anybody noticing.
  const blocks = parseBookingReplies(text);
  if (blocks.length > 0) {
    let filed = 0;
    for (const block of blocks) {
      if (await fileBooking(logRow, block.code, block.parsed)) filed += 1;
    }
    return filed > 0;
  }

  const parsed = await parseTransportConfirmationText(text);
  if (!parsed?.isTransportConfirmation) return false;
  if (!parsed.lorryNumber && !parsed.driverPhone) return false; // nothing actionable
  // A sentence-style message may still quote a code somewhere in its first few
  // lines, so it gets the same lookup - just not the same confidence about
  // where in the message the code was.
  return fileBooking(logRow, parseLorryCode(text), parsed);
}

/**
 * What a requirement code turned out to refer to.
 *
 * Two counters mint these codes - `nextRequirementCode` over purchase orders
 * and `slotCode` over the loading calendar - and they are free to collide, so
 * the lookup is ordered rather than keyed: the purchase side first, the
 * calendar second. The two conversations are with different transporters, so in
 * practice a collision is read correctly by whichever side has the live
 * requirement; where both are live the purchase lorry wins, because that is the
 * one with a driver brief waiting on it.
 */
type ResolvedRequirement =
  | { kind: 'NONE' }
  | { kind: 'PURCHASE'; purchaseOrderId: string; tonnageKg: number }
  | {
      kind: 'LOADING';
      slotId: string;
      transportId: string | null;
      destination: string | null;
      plannedKg: number;
    };

async function resolveRequirementCode(code: string | null): Promise<ResolvedRequirement> {
  if (!code) return { kind: 'NONE' };

  const po = await prisma.purchaseOrder.findUnique({
    where: { requirementCode: code },
    select: { id: true, tonnageKg: true },
  });
  if (po) return { kind: 'PURCHASE', purchaseOrderId: po.id, tonnageKg: po.tonnageKg };

  const slot = await prisma.dispatchSlot.findUnique({
    where: { code },
    select: {
      id: true,
      status: true,
      plannedKg: true,
      transportId: true,
      saleDispatchId: true,
      saleOrder: { select: { destination: true, buyer: { select: { city: true } } } },
    },
  });
  // A slot that has already loaded is history: a late reply quoting its code is
  // not a lorry on its way here, and confirming it would put a second plate on
  // a trip that has gone.
  if (slot && slot.saleDispatchId === null && ACTIVE_SLOT_STATUSES.includes(slot.status)) {
    return {
      kind: 'LOADING',
      slotId: slot.id,
      transportId: slot.transportId,
      destination: slot.saleOrder.destination || slot.saleOrder.buyer.city || null,
      plannedKg: slot.plannedKg,
    };
  }

  return { kind: 'NONE' };
}

/** Where our lorries load and unload, as the company profile has it. */
async function homePlace(): Promise<string> {
  const company = await prisma.companyProfile.findFirst({ select: { dispatchFromPlace: true } });
  return company?.dispatchFromPlace?.trim() || DEFAULT_HOME_PLACE;
}

/**
 * Put the booked lorry on its loading slot.
 *
 * This is what makes the lorry real to the rest of the app: the calendar card
 * stops asking for a plate, the Upcoming tab picks it up, and the ring sweep
 * starts watching it in. Always called AFTER the register row, so a failure
 * here leaves a booking the office can act on by hand.
 *
 * `onlyIfUnset` is for the repeat path: a resend must not overwrite a slot the
 * office has since given a different lorry, but it should still finish the job
 * if the first message filed its booking and then failed on this update.
 */
async function confirmSlotWithBooking(
  slotId: string,
  bookingId: string,
  lorryNumber: string | null,
  parsed: ParsedTransportConfirmation,
  opts: { onlyIfUnset?: boolean } = {},
): Promise<void> {
  if (opts.onlyIfUnset) {
    const slot = await prisma.dispatchSlot.findUnique({
      where: { id: slotId },
      select: { lorryNumber: true, transportConfirmationId: true },
    });
    if (!slot) return;
    if (slot.lorryNumber && slot.lorryNumber !== lorryNumber) return;
    if (slot.lorryNumber && slot.transportConfirmationId) return;
  }
  await prisma.dispatchSlot
    .update({
      where: { id: slotId },
      data: {
        lorryNumber,
        driverName: parsed.driverName ?? undefined,
        driverPhone: parsed.driverPhone ?? undefined,
        status: 'CONFIRMED',
        confirmedAt: new Date(),
        transportConfirmationId: bookingId,
      },
    })
    .catch((err) =>
      logger.warn(
        `[whatsapp] booking ${bookingId} could not confirm slot ${slotId}: ${err?.message ?? err}`,
      ),
    );
}

/**
 * File one lorry into the register, against whatever its code turned out to be.
 *
 * Three outcomes, and the code is what separates them:
 *
 *  - **A purchase requirement.** An inbound lorry coming to us loaded. The
 *    driver gets his brief, as before.
 *  - **A loading slot.** An empty lorry coming to collect a sale load. The slot
 *    is confirmed with his plate and driver, which is what puts him on the
 *    Upcoming tab and inside the approach rings, and the freight is taken from
 *    the rate agreed with that agency for that destination rather than from
 *    whatever figure he typed.
 *  - **Neither.** Still recorded. The office can put the right code on the row
 *    by hand on the register, and nothing is sent in the meantime.
 *
 * A message that says again what the register already knows files nothing. A
 * transporter resends - he is asked to, when the first one was not read, or he
 * simply answers the day's indent twice - and 20NOV-01 ended up on the register
 * twice over one lorry, which is a second trip as far as anyone reading it is
 * concerned. Same code, same plate is the same booking.
 */
async function fileBooking(
  logRow: InboundLogRow,
  requirementCode: string | null,
  parsed: ParsedTransportConfirmation,
): Promise<boolean> {
  const { from, text } = logRow;
  if (!text) return false;
  if (!parsed.lorryNumber && !parsed.driverPhone) return false;

  const requirement = await resolveRequirementCode(requirementCode);
  const lorryNumber = normalizeLorryNumber(parsed.lorryNumber);

  // Only a coded message can be recognised as a repeat: without a code there is
  // no requirement to be the same lorry ON, and two trips by one plate are
  // ordinary. The slot is still reconciled below, so a resend after a failed
  // slot update repairs it instead of filing a twin.
  if (requirementCode && lorryNumber) {
    const twin = await prisma.transportConfirmation.findFirst({
      where: { requirementCode, lorryNumber },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (twin) {
      logger.info(
        `[whatsapp] ${lorryNumber} is already on the register against ${requirementCode} (${twin.id}) - nothing filed for log ${logRow.id}`,
      );
      if (requirement.kind === 'LOADING') {
        await confirmSlotWithBooking(requirement.slotId, twin.id, lorryNumber, parsed, { onlyIfUnset: true });
      }
      return true;
    }
  }

  let destination: string | null = requirement.kind === 'LOADING' ? requirement.destination : null;

  // The transporter names one place; which end of the trip it is depends on the
  // code he answered. The factory is the other end either way.
  const route = bookingRoute({
    direction: requirement.kind === 'PURCHASE' ? 'INBOUND' : 'OUTBOUND',
    fromPlace: parsed.fromPlace ?? null,
    toPlace: parsed.toPlace ?? null,
    destination,
    home: await homePlace(),
  });

  const bookedKg =
    parsed.tonnageKg ?? (requirement.kind === 'LOADING' ? requirement.plannedKg : null);

  // The freight on an outgoing trip is ours to know, not his to quote: where we
  // hold an agreed rate card for that agency and destination, the figure off
  // the card at the booked tonnage is the booking's freight and the dispatch
  // will carry it through. Only when there is no agreed rate does the told
  // amount stand.
  //
  // Resolved for EVERY outbound booking, not only the ones that quoted a
  // requirement code. A message that arrived without a code still names the
  // town and the tonnage, which is all the card needs - and without this the
  // register showed those rows with an empty freight column while the coded
  // ones beside them carried the rate.
  let freightAmount = parsed.freightAmount ?? null;
  let agreedFreight: number | null = null;
  if (requirement.kind !== 'PURCHASE') {
    const transportId =
      requirement.kind === 'LOADING' && requirement.transportId
        ? requirement.transportId
        : (await resolveBookingTransport(null, from ?? null))?.id ?? null;
    agreedFreight = await flatTripFreight(transportId, destination ?? route.toPlace, bookedKg);
    if (agreedFreight != null) freightAmount = agreedFreight;
  }

  const booking = await prisma.transportConfirmation.create({
    data: {
      fromPhone: from ?? 'unknown',
      rawText: text,
      messageDate: parsed.messageDate ? new Date(parsed.messageDate) : null,
      fromPlace: route.fromPlace,
      toPlace: route.toPlace,
      tonnageKg: bookedKg,
      // Normalised on the way in - the dispatch screen looks the row up by lorry
      // number, and that only works if both sides are spelled the same way.
      lorryNumber,
      driverName: parsed.driverName ?? null,
      driverPhone: parsed.driverPhone ?? null,
      freightAmount,
      status: 'WAITING',
      requirementCode,
      // A purchase requirement makes this a lorry coming to us loaded. A
      // loading slot is an outbound trip, as is an unmatched code.
      direction: requirement.kind === 'PURCHASE' ? 'INBOUND' : 'OUTBOUND',
      purchaseOrderId: requirement.kind === 'PURCHASE' ? requirement.purchaseOrderId : null,
      dispatchSlotId: requirement.kind === 'LOADING' ? requirement.slotId : null,
    },
  });
  logger.info(
    `[whatsapp] lorry booking ${booking.id} (${booking.lorryNumber ?? 'no lorry no'}) filed from ${from} against ${requirementCode ?? 'no code'} [${requirement.kind}] (log ${logRow.id})`,
  );

  if (requirement.kind === 'PURCHASE') {
    // Fire-and-forget: a WhatsApp hiccup must not lose the register row, which
    // is the part that matters.
    void sendInboundDriverBrief(booking.id).catch((err) =>
      logger.warn(`[whatsapp] inbound driver brief failed for booking ${booking.id}: ${err?.message ?? err}`),
    );
  }

  if (requirement.kind === 'LOADING') {
    await confirmSlotWithBooking(requirement.slotId, booking.id, lorryNumber, parsed);
    if (agreedFreight != null) {
      logger.info(
        `[whatsapp] slot ${requirementCode} freight set from the agreed rate for ${destination ?? 'destination'}: ₹${agreedFreight}`,
      );
    }
  }

  if (requirement.kind !== 'NONE') {
    // This lorry is now one of ours, so its fixes must be stored at full
    // resolution instead of being thinned to one every five minutes. Without
    // dropping the cache the plate spends up to the cache TTL in the thinned
    // feed - and a lorry booked when it is already close to the factory would
    // cross both approach rings inside that window. Imported here rather than
    // at the top of the file: the GPS service is not otherwise part of the
    // WhatsApp path.
    void import('../services/locanix.service.js')
      .then((m) => m.invalidateActiveDispatchPlates())
      .catch(() => undefined);
  }
  return true;
}

/**
 * Send the arriving driver his brief - factory pin, load, and the two numbers
 * he needs at the gate - and stamp the booking so it only ever goes once.
 *
 * Shared by the automatic path above and the manual button on the register, so
 * the gate is in one place: a booking that is not INBOUND against a matched
 * purchase order is refused, however it got here.
 */
export async function sendInboundDriverBrief(bookingId: string, force = false) {
  const booking = await prisma.transportConfirmation.findUnique({ where: { id: bookingId } });
  if (!booking) throw new HttpError(404, 'Lorry confirmation not found');
  if (booking.direction !== 'INBOUND' || !booking.purchaseOrderId) {
    throw new HttpError(
      400,
      'This booking is not linked to a purchase requirement. Add the requirement code the transporter was given, then send.',
    );
  }
  if (!booking.driverPhone) throw new HttpError(400, 'No driver phone on this booking');
  if (booking.driverBriefSentAt && !force) {
    return { ok: true, skipped: true, error: 'Already sent', sentAt: booking.driverBriefSentAt };
  }

  const po = await prisma.purchaseOrder.findUnique({
    where: { id: booking.purchaseOrderId },
    select: { tonnageKg: true },
  });
  const kg = booking.tonnageKg ?? po?.tonnageKg ?? null;
  const load = kg ? `Black seed - ${(kg / 1000).toFixed(2)} MT` : 'Black seed';

  const result = await whatsappService.notifyInboundDriverBrief({
    bookingId: booking.id,
    driverPhone: booking.driverPhone,
    lorryNumber: booking.lorryNumber,
    load,
    fromPlace: booking.fromPlace,
    language: booking.driverLanguage,
  });

  // Only a real send is stamped. A skip for a missing template or a disabled
  // integration has to stay re-sendable, or turning WhatsApp on later would
  // leave every driver booked in the meantime silently un-briefed.
  if (result?.ok) {
    await prisma.transportConfirmation.update({
      where: { id: booking.id },
      data: { driverBriefSentAt: new Date() },
    });
  }
  return result;
}

/**
 * Process inbound WhatsApp messages from authorized owners/managers to approve,
 * reject, or query driver kata submissions.
 * Returns true if the message was handled as an owner command, false otherwise.
 */
async function processOwnerKataCommand(logRow: InboundLogRow): Promise<boolean> {
  const from = logRow.from;
  const rawText = (logRow.text || '').trim();
  if (!from || !rawText) return false;

  // Clean formatting: strip leading markdown symbols (*, _, ~, #), emojis, and "Reply:" prefix
  let text = rawText.replace(/^[\s*#_~✅👍👉▶️-]+/, '').trim();
  text = text.replace(/^(?:reply|re)\s*:\s*/i, '').trim();
  text = text.replace(/^[\s*#_~✅👍👉▶️-]+/, '').trim();

  const senderDigits = from.replace(/\D/g, '').slice(-10);
  if (senderDigits.length < 10) return false;

  // 1. Verify sender authorization against configured alert recipients / owner numbers
  const recipients = await resolveAlertRecipients();
  const isRecipient = recipients.some((r) => r.replace(/\D/g, '').slice(-10) === senderDigits);

  let isAuthorized = isRecipient;
  if (!isAuthorized) {
    try {
      const profile = await prisma.companyProfile.findUnique({
        where: { id: 'default' },
        select: { ownerWhatsappNumber: true },
      });
      if (profile?.ownerWhatsappNumber && profile.ownerWhatsappNumber.replace(/\D/g, '').slice(-10) === senderDigits) {
        isAuthorized = true;
      }
    } catch {
      // ignore db error
    }
  }

  // Also permit WHATSAPP_TEST_NUMBER for staging/testing
  if (!isAuthorized && process.env.WHATSAPP_TEST_NUMBER) {
    if (process.env.WHATSAPP_TEST_NUMBER.replace(/\D/g, '').slice(-10) === senderDigits) {
      isAuthorized = true;
    }
  }

  if (!isAuthorized) return false;

  const upper = text.toUpperCase();

  // 2. Help Command
  if (upper === 'HELP' || upper === 'KATA' || upper === 'KATA HELP') {
    const helpMsg =
      `🤖 *RVP Kata Approval Assistant*\n\n` +
      `Commands:\n` +
      `• *APPROVE <lorry>* — Confirm delivery using the OCR weight from the slip.\n` +
      `  _Example: APPROVE TN28BF7423_\n` +
      `• *APPROVE <lorry> <weight>* — Confirm delivery with custom weight (kg or tonnes).\n` +
      `  _Example: APPROVE TN28BF7423 24850_ or _APPROVE TN28BF7423 24.85_\n` +
      `• *REJECT <lorry> <reason>* — Reject slip and ask driver to resend.\n` +
      `  _Example: REJECT TN28BF7423 Blurry photo_\n` +
      `• *STATUS <lorry>* — Check delivery status of a lorry.`;
    await sendSessionTextMessage({ to: from, text: helpMsg, relatedType: 'KATA_HELP' });
    return true;
  }

  // 3. Status Query Command
  const statusMatch = text.match(/^(?:STATUS|CHECK)\s+([A-Z0-9\s]+)$/i);
  if (statusMatch) {
    const cleanLorry = statusMatch[1].replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const lorrySuffix = cleanLorry.slice(-4);
    const dispatches = await prisma.saleDispatch.findMany({
      take: 20,
      orderBy: { createdAt: 'desc' },
      include: {
        saleOrder: { include: { buyer: true } },
        kataSubmissions: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    const match = dispatches.find((d) => {
      const v = (d.vehicleNumber || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      return v.includes(cleanLorry) || cleanLorry.includes(v) || (lorrySuffix.length === 4 && v.endsWith(lorrySuffix));
    });

    if (!match) {
      await sendSessionTextMessage({
        to: from,
        text: `❌ No dispatch record found for lorry *${statusMatch[1].trim()}*.`,
        relatedType: 'KATA_STATUS',
      });
      return true;
    }

    const latestSub = match.kataSubmissions[0];
    const subStatus = latestSub ? `Kata Slip: *${latestSub.status}*` : 'No Kata slip submitted yet';
    const statusMsg =
      `📋 *Lorry Status: ${match.vehicleNumber || 'Unknown'}*\n\n` +
      `• *Status:* *${match.status}*\n` +
      `• *Buyer:* ${match.saleOrder.buyer.name}\n` +
      `• *Dispatched Wt:* ${match.weightKg.toLocaleString('en-IN')} kg\n` +
      (match.buyerKataKg ? `• *Buyer Kata Wt:* ${match.buyerKataKg.toLocaleString('en-IN')} kg\n` : '') +
      (match.deliveredDate ? `• *Delivered Date:* ${new Date(match.deliveredDate).toLocaleDateString('en-IN')}\n` : '') +
      `• *${subStatus}*\n` +
      (latestSub?.imageUrl ? `• *Slip Photo:* ${latestSub.imageUrl}\n` : '');

    await sendSessionTextMessage({ to: from, text: statusMsg, relatedType: 'KATA_STATUS' });
    return true;
  }

  // 4. Approve / Confirm / Deliver Command
  // Matches:
  // "APPROVE TN29CJ5359", "APPROVE TN29CJ5359 <34820>", "APPROVE TN29CJ5359 <34820> (override weight)"
  // "APPROVE TN29CJ5359 34820", "APPROVE TN 29 CJ 5359 34,820 kg", "APPROVE TN29CJ5359 34.82 MT"
  if (/^(?:APPROVE|DELIVER|CONFIRM)\b/i.test(text)) {
    let body = text.replace(/^(?:APPROVE|DELIVER|CONFIRM)\s*/i, '').trim();

    // Strip common copy-pasted prompt helpers like "(override weight)", "(confirm delivery)", "(override)"
    body = body.replace(/\((?:confirm\s*delivery|override\s*weight|override|confirm)\)/gi, '').trim();

    let overrideKg: number | undefined;

    // Check for weight in brackets: <...>, [...], (...)
    const bracketMatch = body.match(/[<\[(]([0-9.,]+)\s*(?:kg|kgs|t|mt|tonne|tonnes|ton|tons)?[>\])]/i);
    if (bracketMatch) {
      const numStr = bracketMatch[1].replace(/,/g, '');
      const val = parseFloat(numStr);
      if (!isNaN(val) && val > 0) {
        overrideKg = val < 200 ? Math.round(val * 1000) : Math.round(val);
      }
      body = body.replace(bracketMatch[0], '').trim();
    } else {
      // Check for standalone/trailing weight number with optional units
      const numMatch = body.match(/(?:^|\s+)(\d{1,3}(?:,\d{3})+|\d{4,6}|\d{1,2}(?:\.\d+)?)\s*(?:kg|kgs|t|mt|tonne|tonnes|ton|tons)?(?:\s*\(.*\))?$/i);
      if (numMatch) {
        const numStr = numMatch[1].replace(/,/g, '');
        const val = parseFloat(numStr);
        if (!isNaN(val) && val > 0) {
          overrideKg = val < 200 ? Math.round(val * 1000) : Math.round(val);
        }
        body = body.slice(0, numMatch.index).trim();
      }
    }

    const rawLorry = body.replace(/[^A-Za-z0-9\s-]/g, '').trim();
    const cleanLorry = rawLorry.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const lorrySuffix = cleanLorry.slice(-4);

    if (cleanLorry.length < 3) {
      await sendSessionTextMessage({
        to: from,
        text: `⚠️ Please specify a valid lorry number.\n*Example:* APPROVE TN29CJ5359 or APPROVE TN29CJ5359 34820`,
        relatedType: 'KATA_APPROVE_ERROR',
      });
      return true;
    }

    // Find pending submission first
    const pendingSubs = await prisma.driverKataSubmission.findMany({
      where: { status: 'PENDING' },
      include: {
        saleDispatch: {
          include: { saleOrder: { include: { buyer: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    let sub = pendingSubs.find((s) => {
      const v = (s.saleDispatch.vehicleNumber || s.ocrLorryNumber || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      return v.includes(cleanLorry) || cleanLorry.includes(v) || (lorrySuffix.length === 4 && v.endsWith(lorrySuffix));
    });

    let dispatch = sub?.saleDispatch;

    // If no pending submission was found, check for active DISPATCHED or recently DELIVERED trips (last 14 days)
    if (!dispatch) {
      const recentDispatches = await prisma.saleDispatch.findMany({
        where: {
          status: { in: ['DISPATCHED', 'DELIVERED'] },
          dispatchDate: { gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) },
        },
        include: {
          saleOrder: { include: { buyer: true } },
          kataSubmissions: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
        orderBy: { dispatchDate: 'desc' },
        take: 30,
      });

      dispatch = recentDispatches.find((d) => {
        const v = (d.vehicleNumber || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
        return v.includes(cleanLorry) || cleanLorry.includes(v) || (lorrySuffix.length === 4 && v.endsWith(lorrySuffix));
      });

      if (dispatch && !sub && (dispatch as any).kataSubmissions?.[0]) {
        sub = (dispatch as any).kataSubmissions[0];
      }
    }

    if (!dispatch) {
      await sendSessionTextMessage({
        to: from,
        text: `❌ No active dispatch or pending kata submission found matching lorry *${rawLorry}*.`,
        relatedType: 'KATA_APPROVE_ERROR',
      });
      return true;
    }

    const finalWeightKg = overrideKg ?? sub?.ocrBuyerKataKg ?? (dispatch.buyerKataKg ?? null);
    if (!finalWeightKg || finalWeightKg <= 0) {
      await sendSessionTextMessage({
        to: from,
        text: `⚠️ Could not determine weight for lorry *${dispatch.vehicleNumber || rawLorry}*.\nPlease specify the weight: *APPROVE ${cleanLorry} 34820*`,
        relatedType: 'KATA_APPROVE_ERROR',
      });
      return true;
    }

    try {
      await confirmDelivery({
        dispatchId: dispatch.id,
        buyerKataKg: finalWeightKg,
        deliveredDate: new Date(),
        buyerKataFileUrl: sub?.imageUrl ?? null,
        submissionId: sub?.id,
        confirmedBy: `WhatsApp (+${senderDigits})`,
      });

      const updatedSub = sub
        ? await prisma.driverKataSubmission.findUnique({ where: { id: sub.id } })
        : null;


      // Notify driver via WhatsApp
      const driverPhone = sub?.driverPhone || dispatch.driverPhone;
      const lorryNo = dispatch.vehicleNumber || rawLorry;
      const buyerName = dispatch.saleOrder.buyer.name;
      const shortageKg = Math.max(0, dispatch.weightKg - finalWeightKg);

      if (driverPhone) {
        notifyDriverKataConfirmed(driverPhone, lorryNo, buyerName, shortageKg, {
          driverName: dispatch.driverName,
          grossWeightKg: dispatch.weightKg,
          tareWeightKg: Math.max(0, dispatch.weightKg - finalWeightKg),
          netWeightKg: finalWeightKg,
          imageUrl: sub?.imageUrl || dispatch.buyerKataFileUrl,
          language: (dispatch.saleOrder.buyer as any)?.waLanguage || 'EN',
        }).catch((err) => {
          logger.error('[whatsapp] driver confirmation notify failed', err);
        });
      }

      // Reply back to the Owner on WhatsApp
      const shortageMsg = shortageKg > 0
        ? `📉 Transit Shortage: *${shortageKg.toLocaleString('en-IN')} kg* (${((shortageKg / dispatch.weightKg) * 100).toFixed(2)}%)`
        : '📉 Shortage: *0 kg (No shortage)*';

      const replyMsg =
        `✅ *Delivery Confirmed & Recorded!*\n\n` +
        `🚛 *Lorry:* *${lorryNo}*\n` +
        `🏢 *Buyer:* ${buyerName}\n` +
        `⚖️ *Dispatched Wt:* ${dispatch.weightKg.toLocaleString('en-IN')} kg\n` +
        `⚖️ *Confirmed Kata Wt:* ${finalWeightKg.toLocaleString('en-IN')} kg\n` +
        `${shortageMsg}\n\n` +
        (driverPhone ? `Driver (+${driverPhone}) notified on WhatsApp. 🚛\n` : '') +
        `ERP status updated to *DELIVERED*. 👍`;

      await sendSessionTextMessage({ to: from, text: replyMsg, relatedType: 'KATA_CONFIRMED_OWNER' });
      return true;
    } catch (err: any) {
      logger.error('[whatsapp] owner kata approve error', err);
      await sendSessionTextMessage({
        to: from,
        text: `❌ Error confirming delivery for *${rawLorry}*: ${err?.message || 'Unknown database error'}`,
        relatedType: 'KATA_APPROVE_ERROR',
      });
      return true;
    }
  }

  // 5. Reject Command
  // Matches:
  // "REJECT TN29CJ5359", "REJECT TN29CJ5359 <blurry slip>", "REJECT TN29CJ5359 <reason> (ask driver to resend)"
  // "REJECT TN 28 BF 7423 Blurry photo", "REJECT TN28BF7423 - wrong slip"
  if (/^REJECT\b/i.test(text)) {
    let body = text.replace(/^REJECT\s*/i, '').trim();
    body = body.replace(/\((?:ask\s*driver\s*to\s*resend|resend)\)/gi, '').trim();

    let reason = '';
    const angleMatch = body.match(/[<\[(]([^>\])]+)[>\])]/);
    if (angleMatch) {
      reason = angleMatch[1].trim();
      body = body.replace(angleMatch[0], '').trim();
    } else {
      const parts = body.split(/\s+[-:]\s+|\s+reason\s*:\s*/i);
      if (parts.length > 1) {
        body = parts[0].trim();
        reason = parts.slice(1).join(' ').trim();
      } else {
        const tokens = body.split(/\s+/);
        if (tokens.length > 1) {
          body = tokens[0].trim();
          reason = tokens.slice(1).join(' ').trim();
        }
      }
    }

    const rawLorry = body.replace(/[^A-Za-z0-9\s-]/g, '').trim();
    const cleanLorry = rawLorry.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const lorrySuffix = cleanLorry.slice(-4);
    reason = reason || 'Photo was unclear or unreadable';

    if (cleanLorry.length < 3) {
      await sendSessionTextMessage({
        to: from,
        text: `⚠️ Please specify a valid lorry number.\n*Example:* REJECT TN29CJ5359 blurry photo`,
        relatedType: 'KATA_REJECT_ERROR',
      });
      return true;
    }

    const pendingSubs = await prisma.driverKataSubmission.findMany({
      where: { status: 'PENDING' },
      include: {
        saleDispatch: {
          include: { saleOrder: { include: { buyer: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    const sub = pendingSubs.find((s) => {
      const v = (s.saleDispatch.vehicleNumber || s.ocrLorryNumber || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      return v.includes(cleanLorry) || cleanLorry.includes(v) || (lorrySuffix.length === 4 && v.endsWith(lorrySuffix));
    });

    if (!sub) {
      await sendSessionTextMessage({
        to: from,
        text: `❌ No pending kata submission found for lorry *${rawLorry}*.`,
        relatedType: 'KATA_REJECT_ERROR',
      });
      return true;
    }

    try {
      const updatedSub = await prisma.driverKataSubmission.update({
        where: { id: sub.id },
        data: {
          status: 'REJECTED',
          rejectionReason: reason,
          confirmedBy: `WhatsApp (+${senderDigits})`,
          confirmedAt: new Date(),
        },
        include: {
          saleDispatch: { include: { saleOrder: { include: { buyer: true } } } },
        },
      });


      // Notify driver via WhatsApp
      const lorryNo = sub.saleDispatch.vehicleNumber || rawLorry;
      await notifyDriverKataRejected(sub.driverPhone, lorryNo, reason).catch((err) => {
        logger.error('[whatsapp] driver reject notify failed', err);
      });

      // Confirm to owner
      await sendSessionTextMessage({
        to: from,
        text:
          `❌ *Kata Slip Rejected*\n\n` +
          `🚛 *Lorry:* ${lorryNo}\n` +
          `📝 *Reason:* ${reason}\n\n` +
          `Driver (+${sub.driverPhone}) has been instructed on WhatsApp to re-take and resend a clear photo.`,
        relatedType: 'KATA_REJECTED_OWNER',
      });
      return true;
    } catch (err: any) {
      logger.error('[whatsapp] owner kata reject error', err);
      await sendSessionTextMessage({
        to: from,
        text: `❌ Error rejecting kata slip for *${rawLorry}*: ${err?.message || 'Database error'}`,
        relatedType: 'KATA_REJECT_ERROR',
      });
      return true;
    }
  }

  // 6. If owner message starts with a recognized command keyword but didn't match, help them rather than ignoring
  if (/^(?:APPROVE|DELIVER|CONFIRM|REJECT|STATUS|CHECK)\b/i.test(text)) {
    const helpMsg =
      `🤖 *RVP Kata Assistant*\n\n` +
      `Could not recognize that command format.\n\n` +
      `• *APPROVE <lorry>* — e.g. APPROVE TN29CJ5359\n` +
      `• *APPROVE <lorry> <weight>* — e.g. APPROVE TN29CJ5359 34820\n` +
      `• *REJECT <lorry> <reason>* — e.g. REJECT TN29CJ5359 blurry photo\n` +
      `• *STATUS <lorry>* — e.g. STATUS TN29CJ5359`;
    await sendSessionTextMessage({ to: from, text: helpMsg, relatedType: 'KATA_HELP' });
    return true;
  }

  // Not an owner command - let it fall through
  return false;
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
/** States that mean it's still on track - the send itself stands. */
const DELIVERY_OK = new Set(['sent', 'accepted', 'delivered', 'read']);

/**
 * Receipt word -> the WaDelivery we file. 'sent'/'accepted' are in DELIVERY_OK
 * but map to nothing: they only repeat what the send call already told us, and
 * writing them would overwrite a DELIVERED that arrived first (Fast2SMS does
 * not promise ordering).
 */
const DELIVERY_STATE: Record<string, WaDelivery> = {
  delivered: 'DELIVERED',
  read: 'READ',
  ...Object.fromEntries([...DELIVERY_FAILED].map((w) => [w, 'UNDELIVERED' as const])),
};

/**
 * How far along a receipt is. A later callback may only move a row FORWARD:
 * 'delivered' and 'read' can arrive out of order, and a redelivered webhook can
 * arrive hours late, so without this a stale 'delivered' would quietly undo a
 * 'read' - and worse, undo an UNDELIVERED and hide the failure we added all
 * this for.
 */
const DELIVERY_RANK: Record<WaDelivery, number> = { DELIVERED: 1, READ: 2, UNDELIVERED: 3 };

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
const STATUS_ROW_FIELDS = { id: true, template: true, phone: true, delivery: true } as const;

async function findLogRowForStatus(ev: StatusEvent) {
  if (ev.providerId) {
    const byId = await prisma.whatsAppLog.findFirst({
      where: { direction: 'OUTBOUND', providerId: ev.providerId },
      orderBy: { createdAt: 'desc' },
      select: STATUS_ROW_FIELDS,
    });
    if (byId) return byId;
  }
  const phone = normalizeWhatsAppNumber(ev.phone);
  if (!phone) return null;
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  return prisma.whatsAppLog.findFirst({
    where: { direction: 'OUTBOUND', phone, status: 'SENT', createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    select: STATUS_ROW_FIELDS,
  });
}

/**
 * File a delivery receipt against the originating log row. Never throws - this
 * runs after the webhook has already been acknowledged.
 *
 * A failure writes BOTH `status: 'FAILED'` (as it always did - every existing
 * reader keys off that, and it reopens the double-send guards so the message
 * can be sent again) and the delivery columns. A success touches only the
 * delivery columns, so `status` keeps meaning "handed to Fast2SMS" and the
 * guards keep matching.
 */
async function applyStatusEvent(ev: StatusEvent) {
  const state = DELIVERY_STATE[ev.status];
  if (!state) {
    if (!DELIVERY_OK.has(ev.status)) logger.warn(`[whatsapp] unrecognised delivery status "${ev.status}"`);
    return;
  }

  const failed = state === 'UNDELIVERED';
  const reason = failed ? `Delivery failed (${ev.status})${ev.error ? `: ${ev.error}` : ''}` : null;

  const row = await findLogRowForStatus(ev);
  if (!row) {
    const note = reason ?? `Delivery receipt "${ev.status}"`;
    logger.warn(`[whatsapp] ${note} - no matching log row (id=${ev.providerId}, phone=${ev.phone})`);
    return;
  }

  // Forward only. See DELIVERY_RANK.
  if (row.delivery && DELIVERY_RANK[row.delivery] >= DELIVERY_RANK[state]) return;

  const now = new Date();
  await prisma.whatsAppLog.update({
    where: { id: row.id },
    data: {
      delivery: state,
      deliveryError: reason,
      // 'read' implies delivered, and the delivered receipt is the one that can
      // go missing, so stamp both rather than leaving a read message undated.
      ...(state === 'DELIVERED' ? { deliveredAt: now } : {}),
      ...(state === 'READ' ? { readAt: now, deliveredAt: row.delivery === 'DELIVERED' ? undefined : now } : {}),
      ...(failed ? { status: 'FAILED' as const, errorMessage: reason } : {}),
    },
  });

  const what = `${row.template ?? 'message'} to ${row.phone}`;
  if (failed) logger.error(`[whatsapp] ${what} - ${reason}`);
  else logger.info(`[whatsapp] ${what} - ${state.toLowerCase()}`);
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
  const { from, text, mediaUrl, mediaId } = extractInbound(rawBody);
  if (from && (text || mediaUrl || mediaId)) return { kind: 'inbound' };

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
    // Process message synchronously before acknowledging so container recycling
    // cannot kill the in-flight OCR / notification promise.
    if (logRow) {
      try {
        const handled = await processOwnerKataCommand(logRow);
        if (!handled) {
          const kataHandled = await processDriverKataInbound(logRow);
          if (!kataHandled) {
            const transportHandled = await parseInboundIntoRegister(logRow);
            // If not a transport booking, this is a customer/party inbound message - forward to internal members
            if (!transportHandled && logRow.from && (logRow.text || logRow.mediaUrl)) {
              await notifyInboundMessageToMembers({
                from: logRow.from,
                text: logRow.text,
                mediaUrl: logRow.mediaUrl,
                mediaType: logRow.mediaType,
                logId: logRow.id,
              });
            }
          }
        }
      } catch (err) {
        logger.error(`[whatsapp] inbound processing failed for log ${logRow.id}`, err);
      }
    }
    res.json({ received: true });
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

/**
 * Settings -> WhatsApp -> "Messages that didn't land": every outbound message in
 * the window that either never left (status FAILED from the send call) or left
 * and came back undelivered (delivery UNDELIVERED from the receipt webhook).
 *
 * `receiptsSeen` is the honest part. Delivery receipts only exist if Fast2SMS is
 * configured to POST `status_update` to our webhook; if it isn't, every row sits
 * at delivery=null forever and an empty failure list means NOTHING. So the count
 * of rows that DID get a receipt in the window goes back with the list, and the
 * panel says "receipts aren't arriving" rather than a reassuring green tick.
 */
export async function listWhatsAppDeliveryFailures(req: Request, res: Response) {
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [rows, receiptsSeen, sentCount] = await Promise.all([
    prisma.whatsAppLog.findMany({
      where: {
        direction: 'OUTBOUND',
        createdAt: { gte: since },
        OR: [{ status: 'FAILED' }, { delivery: 'UNDELIVERED' }],
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        createdAt: true,
        phone: true,
        template: true,
        status: true,
        errorMessage: true,
        delivery: true,
        deliveryError: true,
        body: true,
      },
    }),
    prisma.whatsAppLog.count({
      where: { direction: 'OUTBOUND', createdAt: { gte: since }, delivery: { not: null } },
    }),
    prisma.whatsAppLog.count({ where: { direction: 'OUTBOUND', createdAt: { gte: since } } }),
  ]);

  res.json({
    days,
    sentCount,
    receiptsSeen,
    failures: rows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      // One line to show in the table: the delivery reason when WhatsApp gave
      // one, otherwise whatever the send call failed with.
      reason: r.deliveryError ?? r.errorMessage ?? 'Unknown',
      // "never left us" vs "left us and bounced" - different things to fix.
      stage: r.delivery === 'UNDELIVERED' ? ('UNDELIVERED' as const) : ('SEND_FAILED' as const),
      body: (r.body ?? '').slice(0, 300),
    })),
  });
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
    select: {
      poNumber: true,
      pricePerKg: true,
      lorryCount: true,
      stockIns: { select: { id: true } },
    },
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

  // The requirement an inbound booking came in against, so the register can
  // name the supplier rather than showing a bare code.
  const poIds = rows.map((r) => r.purchaseOrderId).filter((id): id is string => !!id);
  const pos = poIds.length
    ? await prisma.purchaseOrder.findMany({
        where: { id: { in: poIds } },
        select: { id: true, poNumber: true, tonnageKg: true, party: { select: { name: true } } },
      })
    : [];
  const poById = new Map(pos.map((p) => [p.id, p]));

  res.json(
    rows.map((r) => {
      const d = r.saleDispatchId ? byId.get(r.saleDispatchId) : null;
      const po = r.purchaseOrderId ? poById.get(r.purchaseOrderId) : null;
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
        requirement: po
          ? { id: po.id, poNumber: po.poNumber, supplier: po.party?.name ?? null, tonnageKg: po.tonnageKg }
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
  if (!row) return res.json(null);
  // Which agency this lorry is running under, so the dispatch dialog can select
  // the transport the moment the number is typed instead of leaving the office
  // to remember it off the message. A booking that came back against a loading
  // slot already names the agency; everything else is resolved on the number
  // the message came FROM, which is the transporter's own WhatsApp.
  const agency = await resolveBookingTransport(row.dispatchSlotId, row.fromPhone);
  res.json({ ...row, transportId: agency?.id ?? null, transportName: agency?.name ?? null });
}

/** The Transport behind a booking: its loading slot first, then the sender's number. */
async function resolveBookingTransport(dispatchSlotId: string | null, fromPhone: string | null) {
  if (dispatchSlotId) {
    const slot = await prisma.dispatchSlot.findUnique({
      where: { id: dispatchSlotId },
      select: { transport: { select: { id: true, name: true } } },
    });
    if (slot?.transport) return slot.transport;
  }
  const want = clean10DigitPhone(fromPhone);
  if (want.length < 10) return null;
  const transports = await prisma.transport.findMany({
    where: { active: true },
    select: { id: true, name: true, phone: true, phone2: true },
  });
  return (
    transports.find(
      (t) => clean10DigitPhone(t.phone) === want || clean10DigitPhone(t.phone2) === want,
    ) ?? null
  );
}

/**
 * Lookup contact details (driver phone/name, transporter, owner) for a lorry.
 * Queries CompanyProfile.companyVehicles, recent SaleDispatches, and TransportConfirmations.
 */
/**
 * Lookup contact details (driver phone/name, transporter, owner) for a lorry.
 * Queries CompanyProfile.companyVehicles (KNM drivers), TransportConfirmations (recent bookings),
 * recent SaleDispatches, and past WeighbridgeTickets.
 */
export async function getLorryContactInfo(req: Request, res: Response) {
  const raw = typeof req.query.lorryNumber === 'string' ? req.query.lorryNumber : '';
  const normalized = normalizeLorryNumber(raw);

  const profile = await prisma.companyProfile.findUnique({
    where: { id: 'default' },
    select: { companyVehicles: true, ownerWhatsappNumber: true },
  });

  const ownerPhone = profile?.ownerWhatsappNumber ? normalizeWhatsAppNumber(profile.ownerWhatsappNumber) : null;

  if (!normalized) {
    return res.json({
      lorryNumber: raw,
      driverName: null,
      driverPhone: null,
      ownerPhone,
      transporterName: null,
      transporterPhone: null,
      source: null,
    });
  }

  // 1. Check company vehicle directory (KNM drivers)
  const cv = findCompanyVehicle(normalized, profile?.companyVehicles);
  if (cv) {
    const driverPhone = cv.driverPhone ? clean10DigitPhone(cv.driverPhone) : '9440416639';
    return res.json({
      lorryNumber: cv.number || raw,
      driverName: cv.driverName || 'KNM Driver',
      driverPhone,
      ownerPhone,
      transporterName: 'KNM Transport',
      transporterPhone: '9440416639',
      isKnm: true,
      billType: 'FREE',
      source: 'company_vehicle',
    });
  }

  // 1b. Single-owner fleets (Transport.payToOwner). Every lorry running under
  // such an agency belongs to one owner who is paid directly, so he - not the
  // driver at the wheel - is the contact for freight money and its receipt.
  // This sits ahead of the driver lookups on purpose: a driver number captured
  // at dispatch or off a WhatsApp booking must never win over the owner.
  const ownerFleetDispatches = await prisma.saleDispatch.findMany({
    where: { vehicleNumber: { not: null }, transport: { is: { payToOwner: true } } },
    orderBy: { dispatchDate: 'desc' },
    include: { transport: true },
    take: 300,
  });
  const ownerFleetTrip = (ownerFleetDispatches ?? []).find(
    (d) => normalizeLorryNumber(d.vehicleNumber) === normalized && d.transport?.payToOwner
  );
  if (ownerFleetTrip?.transport) {
    const agency = ownerFleetTrip.transport;
    const person = (agency.contactPerson || '').trim();
    // Both of the agency's numbers, not the first one that answers: an agency
    // can be two people (Madhupuri has a manager and an owner) and both are
    // told about its freight money. De-duplicated, so one number entered in
    // both columns does not produce two sends.
    const agencyPhones: string[] = [];
    for (const raw2 of [agency.phone, agency.phone2]) {
      const cleaned = clean10DigitPhone(raw2 || '');
      if (cleaned && !agencyPhones.includes(cleaned)) agencyPhones.push(cleaned);
    }
    const agencyPhone = agencyPhones[0] ?? '';
    return res.json({
      lorryNumber: ownerFleetTrip.vehicleNumber || raw,
      driverName: person ? `${person} (${agency.name})` : `${agency.name} (Owner)`,
      driverPhone: agencyPhone || null,
      driverPhone2: agencyPhones[1] ?? null,
      agencyPhones,
      ownerPhone,
      transporterName: agency.name,
      transporterPhone: agencyPhone || null,
      isOwnerPayee: true,
      source: 'transport_owner',
    });
  }

  // 2. Check TransportConfirmations (recent bookings - WAITING / CONFIRMED first, then recent USED/DRAFT)
  const waitingBooking = await prisma.transportConfirmation.findFirst({
    where: {
      lorryNumber: { equals: normalized, mode: 'insensitive' },
      status: { in: ['WAITING', 'CONFIRMED'] },
      OR: [{ driverPhone: { not: null } }, { driverName: { not: null } }],
    },
    orderBy: [{ messageDate: 'desc' }, { createdAt: 'desc' }],
  });

  let matchedBooking = waitingBooking;
  if (!matchedBooking) {
    matchedBooking = await prisma.transportConfirmation.findFirst({
      where: {
        lorryNumber: { equals: normalized, mode: 'insensitive' },
        OR: [{ driverPhone: { not: null } }, { driverName: { not: null } }],
      },
      orderBy: [{ messageDate: 'desc' }, { createdAt: 'desc' }],
    });
  }
  // Loose match fallback across recent confirmations
  if (!matchedBooking) {
    const recentConfirmations = await prisma.transportConfirmation.findMany({
      where: {
        OR: [{ driverPhone: { not: null } }, { driverName: { not: null } }],
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    matchedBooking = recentConfirmations.find(
      (b) => normalizeLorryNumber(b.lorryNumber) === normalized
    ) ?? null;
  }

  if (matchedBooking && (matchedBooking.driverPhone || matchedBooking.driverName)) {
    let suggestedMaterial: string | null = null;
    const rawLower = (matchedBooking.rawText || '').toLowerCase();
    if (rawLower.includes('husk')) suggestedMaterial = 'HUSK';
    else if (rawLower.includes('pappu') || rawLower.includes('dhall') || rawLower.includes('dal')) suggestedMaterial = 'PAPPU';

    return res.json({
      lorryNumber: matchedBooking.lorryNumber || raw,
      driverName: matchedBooking.driverName || null,
      driverPhone: matchedBooking.driverPhone ? clean10DigitPhone(matchedBooking.driverPhone) : null,
      ownerPhone,
      transporterName: null,
      transporterPhone: matchedBooking.fromPhone ? clean10DigitPhone(matchedBooking.fromPhone) : null,
      material: suggestedMaterial,
      bookingStatus: matchedBooking.status,
      source: 'transport_confirmation',
    });
  }

  // 3. Check recent SaleDispatches (lorry has come before for dispatch)
  const dispatches = await prisma.saleDispatch.findMany({
    where: {
      vehicleNumber: { not: null },
    },
    orderBy: { dispatchDate: 'desc' },
    include: { transport: true },
    take: 100,
  });
  const matchedDispatch = dispatches.find(
    (d) => normalizeLorryNumber(d.vehicleNumber) === normalized && (d.driverPhone || d.driverName)
  );
  if (matchedDispatch) {
    return res.json({
      lorryNumber: matchedDispatch.vehicleNumber || raw,
      driverName: matchedDispatch.driverName || null,
      driverPhone: matchedDispatch.driverPhone ? clean10DigitPhone(matchedDispatch.driverPhone) : null,
      ownerPhone,
      transporterName: matchedDispatch.transport?.name || null,
      transporterPhone: matchedDispatch.transport?.phone ? clean10DigitPhone(matchedDispatch.transport.phone) : null,
      source: 'sale_dispatch',
    });
  }

  // 4. Check past Weighbridge Tickets (lorry has come before for kata weighment)
  const tickets = await prisma.weighbridgeTicket.findMany({
    where: {
      vehicleNumber: { not: '' },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  const matchedTicket = tickets.find(
    (t) => normalizeLorryNumber(t.vehicleNumber) === normalized && (t.partyMobile || t.partyName)
  );
  if (matchedTicket) {
    return res.json({
      lorryNumber: matchedTicket.vehicleNumber || raw,
      driverName: null,
      driverPhone: matchedTicket.partyMobile ? clean10DigitPhone(matchedTicket.partyMobile) : null,
      partyName: matchedTicket.partyName || null,
      vehicleType: matchedTicket.vehicleType || null,
      material: matchedTicket.material || null,
      isStorageTransfer: matchedTicket.isStorageTransfer,
      storageLocation: matchedTicket.storageLocation || null,
      billType: matchedTicket.billType || null,
      ownerPhone,
      transporterName: null,
      transporterPhone: null,
      source: 'weighbridge_ticket',
    });
  }

  // Fallback if no specific driver found
  return res.json({
    lorryNumber: raw,
    driverName: null,
    driverPhone: null,
    ownerPhone,
    transporterName: null,
    transporterPhone: null,
    source: null,
  });
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

  // Setting (or correcting) the requirement code is what links a booking to the
  // thing it answers - a purchase order, which unlocks the driver brief, or a
  // loading slot, which puts the lorry on the Upcoming tab and inside the
  // approach rings. Clearing it unlinks both: the register must never be left
  // pointing at a requirement that was typed in error.
  //
  // This is the by-hand path for a message the parse could not place: a
  // transposed code, or a transporter who answered in a sentence. It resolves
  // exactly as the automatic path does, so the two cannot disagree about what a
  // code means.
  if (body.requirementCode !== undefined) {
    let linkedDestination: string | null = null;
    const raw = typeof body.requirementCode === 'string' ? body.requirementCode : '';
    const code = parseLorryCode(raw) ?? (raw.trim() ? raw.trim().toUpperCase() : null);
    if (!code) {
      data.requirementCode = null;
      data.purchaseOrderId = null;
      data.dispatchSlotId = null;
      data.direction = 'OUTBOUND';
    } else {
      const requirement = await resolveRequirementCode(code);
      if (requirement.kind === 'NONE') {
        throw new HttpError(404, `No purchase requirement or loading slot is open under code ${code}`);
      }
      data.requirementCode = code;
      data.purchaseOrderId = requirement.kind === 'PURCHASE' ? requirement.purchaseOrderId : null;
      data.dispatchSlotId = requirement.kind === 'LOADING' ? requirement.slotId : null;
      data.direction = requirement.kind === 'PURCHASE' ? 'INBOUND' : 'OUTBOUND';

      // Linking by hand confirms the slot the same way the WhatsApp path does,
      // or the lorry would sit on the register with nothing watching it in.
      if (requirement.kind === 'LOADING') {
        linkedDestination = requirement.destination;
        const lorryNumber =
          (data.lorryNumber as string | null | undefined) ?? row.lorryNumber ?? null;
        await prisma.dispatchSlot
          .update({
            where: { id: requirement.slotId },
            data: {
              lorryNumber,
              driverName: (data.driverName as string | null) ?? row.driverName ?? undefined,
              driverPhone: (data.driverPhone as string | null) ?? row.driverPhone ?? undefined,
              status: 'CONFIRMED',
              confirmedAt: new Date(),
              transportConfirmationId: row.id,
            },
          })
          .catch((err) =>
            logger.warn(
              `[whatsapp] booking ${row.id} could not confirm slot ${requirement.slotId}: ${err?.message ?? err}`,
            ),
          );
      }
    }

    // A corrected code can turn the trip round - a row filed as a delivery that
    // turns out to answer a purchase requirement, or the reverse - so the route
    // is re-composed against whichever end the factory is now on. A place typed
    // in the same edit is still honoured: it goes in as the away end.
    const route = bookingRoute({
      direction: data.direction as string,
      fromPlace: (data.fromPlace as string | null | undefined) ?? row.fromPlace,
      toPlace: (data.toPlace as string | null | undefined) ?? row.toPlace,
      destination: linkedDestination,
      home: await homePlace(),
    });
    data.fromPlace = route.fromPlace;
    data.toPlace = route.toPlace;
  }
  if (body.driverLanguage !== undefined) {
    const raw = String(body.driverLanguage ?? '').toUpperCase();
    data.driverLanguage = ['EN', 'TE', 'TA', 'KN', 'HI'].includes(raw) ? raw : null;
  }

  // Correcting the tonnage or the town re-reads the agreed rate card: those are
  // exactly the two things the card is keyed on, and a 35 t row fixed to 25 t
  // that kept the 35 t freight is worse than one that was blank. Skipped when
  // the same edit typed a freight by hand - a figure the office entered always
  // outranks the card - and when the lane has no card to read.
  // "Typed" means the figure in the box is not the one already on the row: the
  // edit dialog posts every field back, so merely opening it and fixing the
  // tonnage must not read as a decision about the freight.
  const submittedFreight = data.freightAmount == null ? null : Number(data.freightAmount);
  const storedFreight = row.freightAmount == null ? null : Number(row.freightAmount);
  const freightTyped =
    data.freightAmount !== undefined && submittedFreight !== storedFreight;
  const rateKeyChanged =
    data.tonnageKg !== undefined || data.toPlace !== undefined || data.requirementCode !== undefined;
  const direction = (data.direction as string | undefined) ?? row.direction;
  if (!freightTyped && rateKeyChanged && direction !== 'INBOUND') {
    const agency = await resolveBookingTransport(
      (data.dispatchSlotId as string | null | undefined) ?? row.dispatchSlotId,
      row.fromPhone,
    );
    const toPlace = (data.toPlace as string | null | undefined) ?? row.toPlace;
    const tonnageKg = (data.tonnageKg as number | null | undefined) ?? row.tonnageKg;
    const agreed = await flatTripFreight(agency?.id ?? null, toPlace, tonnageKg);
    if (agreed != null) data.freightAmount = agreed;
  }

  const updated = await prisma.transportConfirmation.update({ where: { id: row.id }, data });
  res.json(updated);
}

/**
 * The manual "Send driver brief" button on the register.
 *
 * The automatic send only fires for a message that quoted its requirement code,
 * which is most of them but never all - so the office needs a way to add the
 * code and send by hand. `force` re-sends one that already went, for the case
 * where the driver says he never got it.
 */
export async function sendInboundDriverBriefHandler(req: Request, res: Response) {
  const force = req.body?.force === true || req.query.force === 'true';
  res.json(await sendInboundDriverBrief(req.params.id, force));
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

// ---------------------------------------------------------------------------
// Dues on this Day (Party & Broker Payment Reminders)
// ---------------------------------------------------------------------------

/** Parse a date string YYYY-MM-DD in IST or default to today */
function parseIstQueryDate(dateStr?: string | null): Date {
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  }
  return new Date();
}

/**
 * List all invoices due on a particular date (defaults to today), along with
 * summary metrics, WhatsApp send statuses for today, and automated schedule configuration.
 */
export async function getDuesOnDate(req: Request, res: Response) {
  const dateStr = typeof req.query.date === 'string' ? req.query.date : undefined;
  const targetDate = parseIstQueryDate(dateStr);
  const dateKey = dateStr || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  const portfolio = await computeBuyerDues(targetDate);
  const profile = await getCompanyProfileRow();

  // Find invoices due on targetDate
  const dueInvoices = portfolio.dueToday;

  // Gather unique buyer IDs to check their last sent WhatsApp logs for today
  const buyerIds = [...new Set(dueInvoices.map((i) => i.buyerId))];
  const logs = await prisma.whatsAppLog.findMany({
    where: {
      relatedType: 'PAYMENT_REMINDER',
      relatedId: { in: buyerIds },
      createdAt: {
        gte: new Date(new Date().setHours(0, 0, 0, 0)),
      },
    },
    orderBy: { createdAt: 'desc' },
    select: { relatedId: true, status: true, createdAt: true },
  });

  const logByBuyer = new Map<string, { status: string; createdAt: Date }>();
  for (const l of logs) {
    if (l.relatedId && !logByBuyer.has(l.relatedId)) {
      logByBuyer.set(l.relatedId, { status: l.status, createdAt: l.createdAt });
    }
  }

  const invoices = dueInvoices.map((inv) => {
    const log = logByBuyer.get(inv.buyerId);
    return {
      dispatchId: inv.dispatchId,
      invoiceNumber: inv.invoiceNumber,
      buyerId: inv.buyerId,
      buyerName: inv.buyerName,
      buyerPhone: inv.buyerPhone ?? null,
      buyerPhone2: inv.buyerPhone2 ?? null,
      buyerWaLanguage: inv.buyerWaLanguage ?? 'EN',
      brokerId: inv.brokerId ?? null,
      brokerName: inv.brokerName ?? null,
      brokerPhone: inv.brokerPhone ?? null,
      brokerWaLanguage: inv.brokerWaLanguage ?? 'EN',
      product: inv.product,
      vehicleNumber: inv.vehicleNumber ?? null,
      billAmount: inv.billAmount,
      outstanding: inv.outstanding,
      dueDate: inv.dueDate.toISOString(),
      billDate: inv.billDate.toISOString(),
      overdue: inv.overdue,
      inTransit: inv.inTransit,
      dueDays: inv.dueDays,
      partiallyPaid: inv.partiallyPaid,
      lastSentAt: log?.createdAt?.toISOString() ?? null,
      lastSentStatus: log?.status ?? null,
    };
  });

  const totalAmount = invoices.reduce((s, i) => s + i.outstanding, 0);
  const buyersCount = new Set(invoices.map((i) => i.buyerId)).size;
  const brokersCount = new Set(invoices.map((i) => i.brokerId).filter(Boolean)).size;
  const sentTodayCount = new Set(invoices.filter((i) => i.lastSentStatus === 'SENT').map((i) => i.buyerId)).size;

  const sweepLog = await prisma.whatsAppLog.findFirst({
    where: { relatedType: 'PARTY_DUE_TODAY_REMINDERS_SWEEP', relatedId: dateKey },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });

  const cronExpr = profile.partyDueTodayReminderCron || '0 9 * * *';
  const scheduleDesc = describeCron(cronExpr);

  res.json({
    date: dateKey,
    invoices,
    stats: {
      totalInvoices: invoices.length,
      totalAmount,
      buyersCount,
      brokersCount,
      sentTodayCount,
    },
    schedule: {
      enabled: profile.partyDueTodayReminderEnabled,
      cron: cronExpr,
      schedule: scheduleDesc,
      target: profile.partyDueTodayReminderTarget || 'BOTH',
      lastSentAt: sweepLog?.createdAt?.toISOString() ?? null,
    },
  });
}

/**
 * Manually send payment reminder for one buyer / set of dispatches.
 */
export async function sendDueOnDateSingle(req: Request, res: Response) {
  const { buyerId, dispatchIds, target } = req.body as {
    buyerId?: string;
    dispatchIds?: string[];
    target?: string;
  };
  if (!buyerId) throw new HttpError(400, 'buyerId is required');
  const result = await runPartyPaymentReminderCore(buyerId, {
    target: target || 'BOTH',
    dispatchIds,
  });
  res.json({
    ok: true,
    ...result,
    message: `Payment reminder sent to ${result.sent.map((s) => s.recipient).join(', ')}${
      result.failed.length ? ` (failed: ${result.failed.map((f) => `${f.recipient} - ${f.error}`).join('; ')})` : ''
    }`,
  });
}

/**
 * Bulk send payment reminders for selected due items or all items on the date.
 */
export async function sendDuesOnDateBulk(req: Request, res: Response) {
  const { items, target: requestedTarget, date: dateStr } = req.body as {
    items?: Array<{ buyerId: string; dispatchIds: string[] }>;
    target?: string;
    date?: string;
  };

  const profile = await getCompanyProfileRow();
  const target = (requestedTarget || profile.partyDueTodayReminderTarget || 'BOTH') as 'PARTY' | 'BROKER' | 'BOTH';

  let toProcess: Array<{ buyerId: string; dispatchIds: string[] }> = [];

  if (items && Array.isArray(items) && items.length > 0) {
    toProcess = items;
  } else {
    const targetDate = parseIstQueryDate(dateStr);
    const portfolio = await computeBuyerDues(targetDate);
    const byBuyer = new Map<string, { buyerId: string; dispatchIds: string[] }>();
    for (const inv of portfolio.dueToday) {
      let entry = byBuyer.get(inv.buyerId);
      if (!entry) {
        entry = { buyerId: inv.buyerId, dispatchIds: [] };
        byBuyer.set(inv.buyerId, entry);
      }
      entry.dispatchIds.push(inv.dispatchId);
    }
    toProcess = [...byBuyer.values()];
  }

  if (toProcess.length === 0) {
    throw new HttpError(400, 'No due invoices to remind about');
  }

  const allSent: Array<{ recipient: string; phone: string | null; amount: number; invoices: number }> = [];
  const allFailed: Array<{ recipient: string; error: string }> = [];

  for (const item of toProcess) {
    try {
      const res = await runPartyPaymentReminderCore(item.buyerId, {
        target,
        dispatchIds: item.dispatchIds,
      });
      allSent.push(...res.sent);
      allFailed.push(...res.failed);
    } catch (err) {
      allFailed.push({
        recipient: item.buyerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (allSent.length === 0) {
    throw new HttpError(502, allFailed[0]?.error ?? 'Failed to send reminders');
  }

  res.json({
    ok: true,
    totalBuyers: toProcess.length,
    sentCount: allSent.length,
    failedCount: allFailed.length,
    sent: allSent,
    failed: allFailed,
    message: `Sent ${allSent.length} reminder(s)${allFailed.length > 0 ? `, ${allFailed.length} failed` : ''}`,
  });
}

/**
 * Update the automated schedule timing & recipient target for "Dues on this Day" reminders.
 */
export async function updatePartyDueTodaySchedule(req: Request, res: Response) {
  const { enabled, hour, minute, days, target } = req.body as {
    enabled?: unknown;
    hour?: unknown;
    minute?: unknown;
    days?: unknown;
    target?: unknown;
  };

  const updateData: {
    partyDueTodayReminderEnabled?: boolean;
    partyDueTodayReminderTarget?: string;
    partyDueTodayReminderCron?: string;
  } = {};

  if (typeof enabled === 'boolean') {
    updateData.partyDueTodayReminderEnabled = enabled;
  }

  if (target && typeof target === 'string' && ['PARTY', 'BROKER', 'BOTH'].includes(target.toUpperCase())) {
    updateData.partyDueTodayReminderTarget = target.toUpperCase();
  }

  if (hour !== undefined && minute !== undefined) {
    if (!Number.isInteger(hour) || (hour as number) < 0 || (hour as number) > 23) {
      throw new HttpError(400, 'hour must be an integer 0-23');
    }
    if (!Number.isInteger(minute) || (minute as number) < 0 || (minute as number) > 59) {
      throw new HttpError(400, 'minute must be an integer 0-59');
    }
    const daysArr = Array.isArray(days) ? days : [];
    if (!daysArr.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
      throw new HttpError(400, 'days must be an array of integers 0-6');
    }
    const cronExpr = buildCron(hour as number, minute as number, daysArr as number[]);
    updateData.partyDueTodayReminderCron = cronExpr;
  }

  await getCompanyProfileRow();
  const updated = await prisma.companyProfile.update({
    where: { id: 'default' },
    data: updateData,
  });

  await reschedulePartyDueTodayJob();

  const cronExpr = updated.partyDueTodayReminderCron || '0 9 * * *';
  res.json({
    enabled: updated.partyDueTodayReminderEnabled,
    cron: cronExpr,
    schedule: describeCron(cronExpr),
    target: updated.partyDueTodayReminderTarget,
  });
}

/**
 * Send Lorry Payment summary directly via WhatsApp API.
 */
export async function sendLorryPaymentWhatsApp(req: Request, res: Response) {
  const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {}) as {
    lorryDetails: any;
    targetPhone: string;
    language?: WaLanguage;
    screenshotUrl?: string;
  };
  const { lorryDetails, targetPhone, language = 'EN', screenshotUrl } = body;

  if (!lorryDetails || !lorryDetails.lorryNumber) {
    throw new HttpError(400, 'Valid lorry payment details required');
  }
  const cleanPhone = normalizeWhatsAppNumber(targetPhone);
  if (!cleanPhone) {
    throw new HttpError(400, 'Valid recipient phone number is required');
  }

  const result = await whatsappService.sendLorryPaymentSummary(
    lorryDetails,
    cleanPhone,
    language,
    screenshotUrl
  );

  if (!result.ok && !result.skipped) {
    return res.status(400).json({ ok: false, message: result.error || 'Failed to send WhatsApp message' });
  }

  return res.json({ ok: true, message: 'Lorry payment receipt sent to driver & copy delivered to Shabari!' });
}

/**
 * Re-send a sale order's confirmation to the buyer (Sale Orders → row action).
 * The same message fires automatically when the order is booked; this is for
 * the order that was edited afterwards, or whose buyer says nothing arrived.
 */
export async function sendSaleOrderConfirmation(req: Request, res: Response) {
  const order = await prisma.saleOrder.findUnique({
    where: { id: req.params.id },
    include: { buyer: true, broker: true },
  });
  if (!order) throw new HttpError(404, 'Sale order not found');

  const phone = order.buyerPhone || order.buyer.phone;
  const phone2 = order.buyerPhone2 || order.buyer.phone2;
  if (!phone && !phone2) throw new HttpError(400, `No WhatsApp number on file for ${order.buyer.name}`);

  const result = await whatsappService.notifySaleOrderConfirmed(
    order,
    { name: order.buyer.name, phone, phone2, waLanguage: order.buyer.waLanguage },
    order.broker
  );
  if (!result.ok) {
    return res.status(400).json({ ok: false, message: result.error || 'Failed to send order confirmation' });
  }
  return res.json({ ok: true, message: `Order confirmation sent to ${order.buyer.name}` });
}

/**
 * List pending and historical driver kata submissions.
 */
export async function listDriverKataSubmissions(req: Request, res: Response) {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const submissions = await prisma.driverKataSubmission.findMany({
    where: status ? { status: status as any } : undefined,
    include: {
      saleDispatch: {
        include: {
          saleOrder: {
            include: { buyer: true, broker: true },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.json(submissions);
}

/**
 * Approve a driver kata submission via Web API (sets weight, marks delivered).
 */
export async function approveDriverKataSubmission(req: Request, res: Response) {
  const { id } = req.params;
  const body = req.body || {};
  const sub = await prisma.driverKataSubmission.findUnique({
    where: { id },
    include: {
      saleDispatch: {
        include: { saleOrder: { include: { buyer: true } } },
      },
    },
  });

  if (!sub) throw new HttpError(404, 'Submission not found');
  if (sub.status !== 'PENDING') throw new HttpError(400, `Submission is already ${sub.status}`);

  const confirmedWeight = body.buyerKataKg != null ? Number(body.buyerKataKg) : sub.ocrBuyerKataKg;
  if (!confirmedWeight || confirmedWeight <= 0) {
    throw new HttpError(400, 'A valid buyer kata weight in kg is required');
  }

  const user = (req as any).user;
  const confirmedBy = user?.name || user?.username || 'Admin';

  const updatedDispatch = await confirmDelivery({
    dispatchId: sub.saleDispatchId,
    buyerKataKg: confirmedWeight,
    deliveredDate: body.deliveredDate ? new Date(body.deliveredDate) : new Date(),
    buyerKataFileUrl: sub.imageUrl,
    submissionId: sub.id,
    confirmedBy,
  });

  // Notify driver via WhatsApp
  const lorry = sub.saleDispatch.vehicleNumber || 'your lorry';
  const buyer = sub.saleDispatch.saleOrder.buyer.name;
  const shortage = Math.max(0, sub.saleDispatch.weightKg - confirmedWeight);
  notifyDriverKataConfirmed(sub.driverPhone, lorry, buyer, shortage, {
    driverName: sub.saleDispatch.driverName,
    grossWeightKg: sub.saleDispatch.weightKg,
    tareWeightKg: Math.max(0, sub.saleDispatch.weightKg - confirmedWeight),
    netWeightKg: confirmedWeight,
    imageUrl: sub.imageUrl,
    language: (sub.saleDispatch.saleOrder.buyer as any)?.waLanguage || 'EN',
  }).catch((err) => {
    logger.error('[whatsapp] driver confirmation notify failed', err);
  });


  res.json({ ok: true, dispatch: updatedDispatch });
}

/**
 * Reject a driver kata submission via Web API.
 */
export async function rejectDriverKataSubmission(req: Request, res: Response) {
  const { id } = req.params;
  const reason = req.body?.reason || 'Slip not clear or unreadable';
  const sub = await prisma.driverKataSubmission.findUnique({
    where: { id },
    include: {
      saleDispatch: {
        include: { saleOrder: { include: { buyer: true } } },
      },
    },
  });

  if (!sub) throw new HttpError(404, 'Submission not found');
  if (sub.status !== 'PENDING') throw new HttpError(400, `Submission is already ${sub.status}`);

  const user = (req as any).user;
  const confirmedBy = user?.name || user?.username || 'Admin';

  const updatedSub = await prisma.driverKataSubmission.update({
    where: { id: sub.id },
    data: {
      status: 'REJECTED',
      rejectionReason: reason,
      confirmedBy,
      confirmedAt: new Date(),
    },
  });

  // Notify driver via WhatsApp
  const lorry = sub.saleDispatch.vehicleNumber || 'your lorry';
  notifyDriverKataRejected(sub.driverPhone, lorry, reason).catch((err) => {
    logger.error('[whatsapp] driver reject notify failed', err);
  });


  res.json({ ok: true, submission: updatedSub });
}

