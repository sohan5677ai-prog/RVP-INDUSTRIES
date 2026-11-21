import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Routing tests for the Fast2SMS webhook. Both inbound messages and delivery
 * receipts land on the same URL, and a webhook registered for `event: "all"`
 * renders ONE payload template for both - so getting this discrimination wrong
 * silently drops transporter messages. Payload shapes below are the ones
 * Fast2SMS documents for a `custom`/SIMPLIFIED template.
 */

const findFirst = vi.fn();
const create = vi.fn();
const update = vi.fn();
const tcCreate = vi.fn();
const tcFindFirst = vi.fn();
const slotFindUnique = vi.fn();
const slotUpdate = vi.fn();
const parseTransport = vi.fn();

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    whatsAppLog: {
      findFirst: (...a: unknown[]) => findFirst(...a),
      create: (...a: unknown[]) => create(...a),
      update: (...a: unknown[]) => update(...a),
    },
    transportConfirmation: {
      create: (...a: unknown[]) => tcCreate(...a),
      findFirst: (...a: unknown[]) => tcFindFirst(...a),
    },
    purchaseOrder: { findUnique: vi.fn().mockResolvedValue(null) },
    dispatchSlot: {
      findUnique: (...a: unknown[]) => slotFindUnique(...a),
      update: (...a: unknown[]) => slotUpdate(...a),
    },
    party: { findFirst: vi.fn().mockResolvedValue(null) },
    broker: { findFirst: vi.fn().mockResolvedValue(null) },
    saleDispatch: { findFirst: vi.fn().mockResolvedValue(null) },
    companyProfile: {
      findUnique: vi.fn().mockResolvedValue({ alertRecipients: JSON.stringify([{ name: 'Owner', phone: '9902953300' }]) }),
      // bookingRoute's homePlace() reads this. Without it every booking threw
      // on the way into the register, and the throw was swallowed by the
      // webhook's catch - so the tests failed on a missing create, three
      // layers from the cause.
      findFirst: vi.fn().mockResolvedValue({ dispatchFromPlace: 'Punganur' }),
    },
  },
}));

vi.mock('../lib/gemini.js', () => ({
  parseTransportConfirmationText: (...a: unknown[]) => parseTransport(...a),
}));
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../services/dispatchWhatsapp.service.js', () => ({
  sendDispatchBundleWhatsApp: vi.fn(),
  resendDispatchDriverWhatsApp: vi.fn(),
}));
vi.mock('../jobs/whatsappJobs.js', () => ({ JOB_RUNNERS: {} }));
vi.mock('../services/whatsapp.service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The photo tests below must not reach out to files.fast2sms.com.
  downloadWhatsAppMedia: vi.fn().mockResolvedValue(null),
  notifyInboundMessageToMembers: vi.fn(),
}));

const { handleWhatsAppWebhook } = await import('./whatsapp.controller.js');
const { notifyInboundMessageToMembers } = await import('../services/whatsapp.service.js');

/** Drive the handler and wait for its detached background processing. */
async function post(body: unknown, headers: Record<string, string> = {}) {
  const res = {
    statusCode: 200,
    json: vi.fn(),
    status(code: number) { this.statusCode = code; return this; },
  };
  const req = { body, header: (k: string) => headers[k.toLowerCase()] };
  await handleWhatsAppWebhook(req as never, res as never);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return res;
}

const TRANSPORT_TEXT =
  '2/8/26 Punganur To Surath 30 Tones Loading Lorry Details TN 86 A 6588 (14W) Karthik +91 9943262021  Per Tone Lorry Freight Rs 80000/-';

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.FAST2SMS_WEBHOOK_SECRET;
  findFirst.mockResolvedValue(null);
  create.mockResolvedValue({ id: 'log1' });
  tcCreate.mockResolvedValue({ id: 'tc1' });
  tcFindFirst.mockResolvedValue(null);
  slotFindUnique.mockResolvedValue(null);
  slotUpdate.mockResolvedValue({});
  parseTransport.mockResolvedValue({
    isTransportConfirmation: true,
    lorryNumber: 'TN86A6588',
    driverName: 'Karthik',
    driverPhone: '9943262021',
    freightAmount: 80000,
    tonnageKg: 30000,
  });
});

describe('Fast2SMS webhook routing', () => {
  it('files an incoming_message as an inbound message', async () => {
    await post({
      webhook_type: 'incoming_message',
      from: '919943262021',
      message_type: 'text',
      body: TRANSPORT_TEXT,
      message_id: 'wamid.ABC123',
    });
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0].data).toMatchObject({ direction: 'INBOUND', providerId: 'wamid.ABC123' });
    expect(tcCreate).toHaveBeenCalledOnce();
  });

  it('files the booking as WAITING with a normalised lorry number', async () => {
    // The register is matched against a dispatch by lorry number alone, so a
    // number stored the way the message spelled it ("TN 86 A 6588") would never
    // find its trip.
    parseTransport.mockResolvedValue({
      isTransportConfirmation: true,
      lorryNumber: 'tn 86-a 6588',
      driverName: 'Karthik',
      driverPhone: '9943262021',
      freightAmount: 80000,
      tonnageKg: 30000,
    });
    await post({ webhook_type: 'incoming_message', from: '919943262021', body: TRANSPORT_TEXT, message_id: 'wamid.N1' });
    expect(tcCreate.mock.calls[0][0].data).toMatchObject({
      status: 'WAITING',
      lorryNumber: 'TN86A6588',
      driverName: 'Karthik',
      driverPhone: '9943262021',
      tonnageKg: 30000,
      freightAmount: 80000,
    });
  });

  it('files nothing when the same lorry is resent against the same code', async () => {
    // Pravin resent 20NOV-01 on 21 Nov and the register took a second row for
    // the one lorry, which reads as a second trip to anybody looking at it.
    tcFindFirst.mockResolvedValue({ id: 'tc-already' });
    const body = '20NOV-01 35 Tons to Surat\nGJ18BW7697\n9974458416\n35 MT';
    const res = await post({ webhook_type: 'incoming_message', from: '917227021924', body, message_id: 'wamid.DUP' });
    expect(tcFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { requirementCode: '20NOV-01', lorryNumber: 'GJ18BW7697' } }),
    );
    expect(tcCreate).not.toHaveBeenCalled();
    // Still "handled", so it is not forwarded to the members as a stray
    // message - the slot update below is the only write a repeat may make.
    expect(notifyInboundMessageToMembers).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('files a different lorry quoting the same code - that is a replacement', async () => {
    tcFindFirst.mockResolvedValue(null);
    const body = '20NOV-01 35 Tons to Surat\nGJ18BV9999\n9974458416\n35 MT';
    await post({ webhook_type: 'incoming_message', from: '917227021924', body, message_id: 'wamid.REPL' });
    expect(tcCreate).toHaveBeenCalledOnce();
    expect(tcCreate.mock.calls[0][0].data).toMatchObject({
      requirementCode: '20NOV-01',
      lorryNumber: 'GJ18BV9999',
    });
  });

  it('treats status "received" as inbound, not a delivery receipt', async () => {
    // The regression this guards: an `event: "all"` template stamps status on
    // EVERY event, so an inbound message arrives looking like a status update.
    await post({
      webhook_type: 'incoming_message',
      status: 'received',
      from: '919943262021',
      body: TRANSPORT_TEXT,
      message_id: 'wamid.DEF456',
    });
    expect(tcCreate).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
  });

  it('routes an unlabelled status:received payload to the inbound path', async () => {
    await post({ status: 'received', from: '919943262021', body: TRANSPORT_TEXT, message_id: 'wamid.G' });
    expect(tcCreate).toHaveBeenCalledOnce();
  });

  it('marks a failed status_update on the originating log row', async () => {
    findFirst.mockResolvedValue({ id: 'log9', template: 'DISPATCH_DRIVER', phone: '919943262021' });
    await post({
      webhook_type: 'status_update',
      status: 'failed',
      message_id: 'wamid.XYZ',
      recipient_id: '919943262021',
      error_message: 'Template paused',
    });
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0][0].data.status).toBe('FAILED');
    // A delivery receipt must never reach Gemini as a transporter message.
    expect(tcCreate).not.toHaveBeenCalled();
    expect(parseTransport).not.toHaveBeenCalled();
  });

  it('does not file a booking for a delivered status_update', async () => {
    await post({ webhook_type: 'status_update', status: 'delivered', message_id: 'w1', recipient_id: '919943262021' });
    expect(tcCreate).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('ignores a retried duplicate of an inbound message', async () => {
    findFirst.mockResolvedValue({ id: 'logExisting' });
    await post({ webhook_type: 'incoming_message', from: '91994', body: TRANSPORT_TEXT, message_id: 'wamid.SAME' });
    expect(create).not.toHaveBeenCalled();
    expect(tcCreate).not.toHaveBeenCalled();
  });

  it('treats an unlabelled message with any other status word as inbound', async () => {
    // The regression this guards: only `status: "received"` used to be rescued,
    // so any other word Fast2SMS stamps on an inbound message fell through to
    // the delivery-receipt path, matched neither status set, and was dropped
    // without a log row or a draft - the message simply never arrived.
    await post({ status: 'success', from: '919943262021', body: TRANSPORT_TEXT, message_id: 'wamid.S1' });
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0].data).toMatchObject({ direction: 'INBOUND' });
    expect(tcCreate).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
  });

  it('files an unrecognisable payload rather than dropping it', async () => {
    await post({ something: 'unexpected' });
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0].data.direction).toBe('INBOUND');
  });

  it('asks Fast2SMS to retry when the inbound message cannot be stored', async () => {
    // Acknowledging a message we failed to persist would lose it permanently:
    // Fast2SMS never retries an event it saw a 2xx for.
    create.mockRejectedValue(new Error('db down'));
    const res = await post({
      webhook_type: 'incoming_message', from: '919943262021', body: TRANSPORT_TEXT, message_id: 'wamid.DB',
    });
    expect(res.statusCode).toBe(503);
  });

  it('persists the message before acknowledging it', async () => {
    const order: string[] = [];
    create.mockImplementation(async () => { order.push('write'); return { id: 'log1' }; });
    const res = { statusCode: 200, json: () => { order.push('ack'); }, status(c: number) { this.statusCode = c; return this; } };
    const req = { body: { webhook_type: 'incoming_message', from: '919943262021', body: TRANSPORT_TEXT, message_id: 'w9' }, header: () => undefined };
    await handleWhatsAppWebhook(req as never, res as never);
    expect(order).toEqual(['write', 'ack']);
  });

  it('does not mistake a reused request_id for a duplicate', async () => {
    // Dedupe matches on id AND body: if Fast2SMS ever sends a per-webhook
    // request_id instead of a per-message wamid, matching on the id alone would
    // discard every message after the first, forever.
    findFirst.mockImplementation(async (args: any) =>
      args.where.body === 'an older message that reused the id' ? { id: 'logExisting' } : null
    );
    await post({ webhook_type: 'incoming_message', from: '919943262021', body: TRANSPORT_TEXT, message_id: 'reused-id' });
    expect(findFirst.mock.calls[0][0].where).toMatchObject({ providerId: 'reused-id', body: TRANSPORT_TEXT });
    expect(create).toHaveBeenCalledOnce();
    expect(tcCreate).toHaveBeenCalledOnce();
  });

  it('does not read a booking out of a photo message', async () => {
    // What this guards: a photo arrives with the media's own URL sitting in the
    // message body. Its digits read enough like a date and a lorry number that
    // Gemini answered with the worked example from its own prompt, and every
    // picture anyone sent the shared number filed another phantom booking -
    // the register's repeated "18 Jul 2026 / AP39T8217 / Moula / Rs 80,000"
    // rows. A link carries nothing to read, so the model is never asked.
    await post({
      webhook_type: 'incoming_message',
      from: '919444666577',
      message_type: 'image',
      body: 'https://files.fast2sms.com/chat_uploads/2012326/1674492334027097.jpg',
      message_id: 'wamid.IMG1',
    });
    expect(parseTransport).not.toHaveBeenCalled();
    expect(tcCreate).not.toHaveBeenCalled();
  });

  it('does not read a booking out of a voice note or PDF', async () => {
    for (const [i, url] of [
      'https://files.fast2sms.com/chat_uploads/2012326/4675979809313355.ogg',
      'https://files.fast2sms.com/chat_uploads/2012326/1125466717117686.pdf',
    ].entries()) {
      await post({ webhook_type: 'incoming_message', from: '919254890004', body: url, message_id: `wamid.M${i}` });
    }
    expect(parseTransport).not.toHaveBeenCalled();
    expect(tcCreate).not.toHaveBeenCalled();
  });

  it('rejects a call with the wrong secret when one is configured', async () => {
    process.env.FAST2SMS_WEBHOOK_SECRET = 'realsecret';
    const res = await post({ webhook_type: 'incoming_message', body: TRANSPORT_TEXT }, { webhook_secret_key: 'nope' });
    expect(res.statusCode).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });

  it('accepts a call carrying the right secret', async () => {
    process.env.FAST2SMS_WEBHOOK_SECRET = 'realsecret';
    const res = await post(
      { webhook_type: 'incoming_message', from: '91994', body: TRANSPORT_TEXT, message_id: 'w2' },
      { webhook_secret_key: 'realsecret' },
    );
    expect(res.statusCode).toBe(200);
    expect(tcCreate).toHaveBeenCalledOnce();
  });

  it('forwards general inbound customer messages to internal team members', async () => {
    parseTransport.mockResolvedValue({ isTransportConfirmation: false });
    const res = await post({
      webhook_type: 'incoming_message',
      from: '919876543210',
      body: 'Hello please share latest seed prices',
      message_id: 'wamid.CUST1',
    });
    expect(res.statusCode).toBe(200);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          direction: 'INBOUND',
          phone: '919876543210',
          body: 'Hello please share latest seed prices',
        }),
      })
    );
    expect(tcCreate).not.toHaveBeenCalled();
  });
});

