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
const parseTransport = vi.fn();

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    whatsAppLog: {
      findFirst: (...a: unknown[]) => findFirst(...a),
      create: (...a: unknown[]) => create(...a),
      update: (...a: unknown[]) => update(...a),
    },
    transportConfirmation: { create: (...a: unknown[]) => tcCreate(...a) },
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

const { handleWhatsAppWebhook } = await import('./whatsapp.controller.js');

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

  it('does not create a draft for a delivered status_update', async () => {
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
});
