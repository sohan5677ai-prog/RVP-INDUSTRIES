import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The internal Kata alert carries the slip as an image URL that WhatsApp's
 * media fetcher pulls from our own endpoint. Sender and endpoint used to mint
 * that token from different timestamps, so an unpaid ticket's link 403'd and
 * the alert went out with no slip. These tests drive the real sender and the
 * real endpoint against each other, so the two cannot drift again.
 */

const mockTicketFindUnique = vi.fn();
const mockPrisma = {
  companyProfile: { findFirst: vi.fn(), findUnique: vi.fn() },
  weighbridgeTicket: {
    findUnique: (...args: any[]) => mockTicketFindUnique(...args),
    update: vi.fn().mockResolvedValue({}),
  },
  party: { findFirst: vi.fn() },
  whatsAppLog: { create: vi.fn().mockResolvedValue({}) },
  printJob: { create: vi.fn().mockResolvedValue({}) },
};

vi.mock('../lib/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../lib/weighbridgeSlipImage.js', () => ({
  generateWeighbridgeSlipJpeg: vi.fn().mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0x00])),
}));

const mockFetch = vi.fn();
globalThis.fetch = mockFetch as any;

const { notifyInternalKataCompleted } = await import('./whatsapp.service.js');
const { downloadSignedWeighbridgeSlipImageHandler } = await import(
  '../controllers/weighbridge.controller.js'
);

/** The slip.jpg URL the sender handed to Fast2SMS. */
function sentSlipUrl(): URL {
  const call = mockFetch.mock.calls.find((c) =>
    String(c[0]).includes('media_url'),
  );
  expect(call, 'no send carried a media_url').toBeTruthy();
  const mediaUrl = new URL(String(call![0])).searchParams.get('media_url');
  return new URL(String(mediaUrl));
}

/** Fetch that URL through the real endpoint, the way WhatsApp would. */
async function fetchSlip(url: URL, ticket: any) {
  mockTicketFindUnique.mockResolvedValue(ticket);
  const id = url.pathname.split('/').at(-2)!;
  const req: any = { params: { id }, query: { token: url.searchParams.get('token') } };
  const res: any = { setHeader: vi.fn(), send: vi.fn() };
  await downloadSignedWeighbridgeSlipImageHandler(req, res);
  return res;
}

describe('Kata slip link: sender and endpoint agree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FAST2SMS_API_KEY = 'test_key';
    process.env.WHATSAPP_ENABLED = 'true';
    process.env.WHATSAPP_TEST_MODE = 'false';
    process.env.JWT_SECRET = 'test-secret';
    const profile = {
      alertRecipients: JSON.stringify([{ name: 'Director', phone: '9440416639' }]),
      ownerWhatsappNumber: '9440416639',
      whatsappTestMode: false,
    };
    mockPrisma.companyProfile.findFirst.mockResolvedValue(profile);
    mockPrisma.companyProfile.findUnique.mockResolvedValue(profile);
    mockFetch.mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(JSON.stringify({ return: true, request_id: 'req_1' })),
    });
  });

  // The regression: cash not yet collected, so paidAt is null and the second
  // weight was taken hours after the ticket was opened. Signing over
  // secondWeighedAt made this link 403.
  it('mints a link the endpoint accepts for an unpaid ticket', async () => {
    const ticket = {
      id: 'ticket_unpaid',
      ticketNo: 201,
      vehicleNumber: 'AP39UX9108',
      material: 'TAMARIND SEED',
      partyName: 'MURALI',
      firstWeightKg: 11710,
      secondWeightKg: 32270,
      netWeightKg: 20560,
      paidAt: null,
      createdAt: new Date('2026-11-19T07:55:47.449Z'),
      secondWeighedAt: new Date('2026-11-19T12:29:56.405Z'),
    };

    const result = await notifyInternalKataCompleted(ticket);
    expect(result.ok).toBe(true);

    const res = await fetchSlip(sentSlipUrl(), ticket);
    expect(res.send).toHaveBeenCalled();
  });

  it('mints a link the endpoint accepts once the ticket has been paid', async () => {
    const paidAt = new Date('2026-11-19T05:27:39.651Z');
    const ticket = {
      id: 'ticket_paid',
      ticketNo: 202,
      vehicleNumber: 'TN28BF7423',
      material: 'HUSK',
      partyName: null,
      isStorageTransfer: true,
      storageLocation: 'PGR COLD',
      transferDirection: 'RVP_TO_STORAGE',
      firstWeightKg: 10000,
      secondWeightKg: 25000,
      netWeightKg: 15000,
      paidAt,
      createdAt: new Date('2026-11-19T02:07:44.094Z'),
      secondWeighedAt: paidAt,
    };

    const result = await notifyInternalKataCompleted(ticket);
    expect(result.ok).toBe(true);

    const res = await fetchSlip(sentSlipUrl(), ticket);
    expect(res.send).toHaveBeenCalled();
  });

  it('rejects a link signed over the second-weight time (the old bug)', async () => {
    const { weighbridgeSlipToken } = await import('../lib/weighbridgeSlipToken.js');
    const ticket = {
      id: 'ticket_unpaid',
      ticketNo: 203,
      paidAt: null,
      createdAt: new Date('2026-11-19T07:55:47.449Z'),
      secondWeighedAt: new Date('2026-11-19T12:29:56.405Z'),
    };
    const stale = weighbridgeSlipToken(ticket.id, null, ticket.secondWeighedAt)!;
    const url = new URL(
      `https://example.com/api/weighbridge/tickets/${ticket.id}/slip.jpg?token=${stale}`,
    );
    await expect(fetchSlip(url, ticket)).rejects.toThrow(/Invalid slip link/);
  });
});

describe('weighbridgeSlipToken', () => {
  it('signs over paidAt when present and createdAt otherwise', async () => {
    const { weighbridgeSlipToken } = await import('../lib/weighbridgeSlipToken.js');
    const paidAt = new Date('2026-11-19T05:00:00Z');
    const createdAt = new Date('2026-11-19T02:00:00Z');
    expect(weighbridgeSlipToken('t', paidAt, createdAt)).toBe(
      weighbridgeSlipToken('t', paidAt, null),
    );
    expect(weighbridgeSlipToken('t', null, createdAt)).toBe(
      weighbridgeSlipToken('t', createdAt, null),
    );
    expect(weighbridgeSlipToken('t', null, createdAt)).not.toBe(
      weighbridgeSlipToken('t', paidAt, createdAt),
    );
  });

  it('accepts ISO strings as well as Dates, and returns null with no stamp', async () => {
    const { weighbridgeSlipToken } = await import('../lib/weighbridgeSlipToken.js');
    const createdAt = new Date('2026-11-19T02:00:00Z');
    expect(weighbridgeSlipToken('t', null, createdAt.toISOString())).toBe(
      weighbridgeSlipToken('t', null, createdAt),
    );
    expect(weighbridgeSlipToken('t', null, null)).toBeNull();
    expect(weighbridgeSlipToken('t', null, 'not-a-date')).toBeNull();
  });
});
