import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The driver kata leg of the Fast2SMS webhook.
 *
 * What these guard: between 29 Oct and 19 Nov 2026 every buyer weighbridge slip
 * that arrived on the shared number was filed as an ordinary photo and
 * forwarded to staff, and not one DriverKataSubmission was written. The handler
 * did its network work first and matched afterwards, so a media download that
 * came back null - or a model that would not commit to "this is a kata slip" -
 * was indistinguishable from "not a kata slip at all", and the slip was dropped
 * with no row, no alert and no trace.
 */

const logFindFirst = vi.fn();
const logCreate = vi.fn();
const dispatchFindFirst = vi.fn();
const dispatchFindMany = vi.fn();
const submissionCreate = vi.fn();
const submissionUpdate = vi.fn();
const parseKata = vi.fn();
const download = vi.fn();
const notifyMembers = vi.fn();
const notifyOwners = vi.fn();
const uploadBuffer = vi.fn();

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    whatsAppLog: {
      findFirst: (...a: unknown[]) => logFindFirst(...a),
      create: (...a: unknown[]) => logCreate(...a),
      update: vi.fn(),
    },
    saleDispatch: {
      findFirst: (...a: unknown[]) => dispatchFindFirst(...a),
      findMany: (...a: unknown[]) => dispatchFindMany(...a),
    },
    driverKataSubmission: {
      create: (...a: unknown[]) => submissionCreate(...a),
      update: (...a: unknown[]) => submissionUpdate(...a),
    },
    transportConfirmation: { create: vi.fn() },
    party: { findFirst: vi.fn().mockResolvedValue(null) },
    broker: { findFirst: vi.fn().mockResolvedValue(null) },
    companyProfile: {
      findUnique: vi.fn().mockResolvedValue({
        alertRecipients: JSON.stringify([{ name: 'Owner', phone: '9902953300' }]),
        ownerWhatsappNumber: '9902953300',
      }),
    },
  },
}));

vi.mock('../lib/gemini.js', () => ({
  parseTransportConfirmationText: vi.fn().mockResolvedValue({ isTransportConfirmation: false }),
  parseBuyerKataImage: (...a: unknown[]) => parseKata(...a),
}));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../lib/upload.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  uploadBufferToStorage: (...a: unknown[]) => uploadBuffer(...a),
}));
vi.mock('../slack/app.js', () => ({
  getSlackApp: () => null,
  postSlackMessage: vi.fn().mockResolvedValue(null),
  updateSlackMessage: vi.fn().mockResolvedValue(false),
  slackAlertChannel: () => null,
}));
vi.mock('../services/dispatchWhatsapp.service.js', () => ({
  sendDispatchBundleWhatsApp: vi.fn(),
  resendDispatchDriverWhatsApp: vi.fn(),
}));
vi.mock('../jobs/whatsappJobs.js', () => ({ JOB_RUNNERS: {} }));
vi.mock('../services/whatsapp.service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  downloadWhatsAppMedia: (...a: unknown[]) => download(...a),
  notifyInboundMessageToMembers: (...a: unknown[]) => notifyMembers(...a),
  notifyOwnersKataReceived: (...a: unknown[]) => notifyOwners(...a),
  notifyDriverKataReceived: vi.fn().mockResolvedValue(undefined),
  sendSessionTextMessage: vi.fn().mockResolvedValue({ ok: true }),
  resolveAlertRecipients: vi.fn().mockResolvedValue(['9902953300']),
}));

const { handleWhatsAppWebhook } = await import('./whatsapp.controller.js');

const SLIP_URL = 'https://files.fast2sms.com/chat_uploads/2012326/28804464899230922.jpg';

/** A dispatch shaped the way the handler's include clause returns it. */
function dispatchRow(over: Record<string, unknown> = {}) {
  return {
    id: 'disp1',
    status: 'DISPATCHED',
    vehicleNumber: 'GJ18BV5741',
    driverPhone: '9050306685',
    weightKg: 35000,
    dispatchDate: new Date('2026-11-16'),
    saleOrder: { product: 'PAPPU', buyer: { name: 'Shreejee Cotex' } },
    ...over,
  };
}

async function postPhoto(from: string) {
  const res = { statusCode: 200, json: vi.fn(), status(c: number) { this.statusCode = c; return this; } };
  const req = {
    body: { webhook_type: 'incoming_message', from, message_type: 'image', body: SLIP_URL, message_id: `wamid.${from}` },
    header: () => undefined,
  };
  await handleWhatsAppWebhook(req as never, res as never);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.FAST2SMS_WEBHOOK_SECRET;
  logFindFirst.mockResolvedValue(null);
  logCreate.mockResolvedValue({ id: 'log1' });
  dispatchFindFirst.mockResolvedValue(null);
  dispatchFindMany.mockResolvedValue([]);
  submissionCreate.mockResolvedValue({ id: 'sub1' });
  uploadBuffer.mockResolvedValue('https://storage.example/slip.jpg');
  download.mockResolvedValue({ buffer: Buffer.from('jpegbytes'), mimeType: 'image/jpeg' });
});

describe('inbound buyer kata slip', () => {
  it('matches on the lorry number even when the model will not call it a kata slip', async () => {
    // Slips reach us forwarded from the office, not from the number in
    // driverPhone, so the lorry number is the match that carries the traffic -
    // and the model routinely reads a registration off a photo it has flagged
    // isBuyerKataSlip:false. Gating the fallback on that flag threw the match
    // away and the slip with it.
    parseKata.mockResolvedValue({
      isBuyerKataSlip: false,
      lorryNumber: 'GJ18BV5741',
      buyerKataKg: 34860,
      rawResponse: { isBuyerKataSlip: false },
    });
    dispatchFindMany.mockResolvedValue([dispatchRow()]);

    await postPhoto('919902953300');

    expect(submissionCreate).toHaveBeenCalledOnce();
    expect(submissionCreate.mock.calls[0][0].data).toMatchObject({
      saleDispatchId: 'disp1',
      ocrBuyerKataKg: 34860,
      ocrLorryNumber: 'GJ18BV5741',
      status: 'PENDING',
    });
    expect(notifyMembers).not.toHaveBeenCalled();
  });

  it('still files the slip against the trip when the image cannot be downloaded', async () => {
    // A download that fails is not evidence the photo was not a kata slip. The
    // sender's own trip is known without reading anything, so file it with the
    // sender's link and let a human key the weight in.
    download.mockResolvedValue(null);
    dispatchFindFirst.mockResolvedValue(dispatchRow());

    await postPhoto('919050306685');

    expect(submissionCreate).toHaveBeenCalledOnce();
    expect(submissionCreate.mock.calls[0][0].data).toMatchObject({
      saleDispatchId: 'disp1',
      imageUrl: SLIP_URL,
      ocrBuyerKataKg: null,
    });
    expect(notifyOwners).toHaveBeenCalledOnce();
    expect(parseKata).not.toHaveBeenCalled();
  });

  it('keeps the sender link when the storage upload fails', async () => {
    parseKata.mockResolvedValue({ isBuyerKataSlip: true, lorryNumber: 'GJ18BV5741', buyerKataKg: 34860 });
    dispatchFindFirst.mockResolvedValue(dispatchRow());
    uploadBuffer.mockRejectedValue(new Error('bucket is private'));

    await postPhoto('919050306685');

    expect(submissionCreate).toHaveBeenCalledOnce();
    expect(submissionCreate.mock.calls[0][0].data).toMatchObject({ imageUrl: SLIP_URL });
  });

  it('forwards an undownloadable photo from a stranger instead of filing it', async () => {
    // No trip to attach it to and nothing read off it: it is just a photo, and
    // staff still get it on the generic forward.
    download.mockResolvedValue(null);

    await postPhoto('919444666577');

    expect(submissionCreate).not.toHaveBeenCalled();
    expect(notifyMembers).toHaveBeenCalledOnce();
  });
});
