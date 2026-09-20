import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPrisma = {
  companyProfile: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
  },
  weighbridgeTicket: {
    update: vi.fn().mockResolvedValue({}),
  },
  whatsAppLog: {
    create: vi.fn().mockResolvedValue({}),
  },
};

vi.mock('../lib/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock fetch globally
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

describe('notifyInternalKataCompleted', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FAST2SMS_API_KEY = 'test_key';
    process.env.WHATSAPP_ENABLED = 'true';
    process.env.WHATSAPP_TEST_MODE = 'false';
    const profile = {
      alertRecipients: JSON.stringify([
        { name: 'Director', phone: '9440416639' },
        { name: 'Manager', phone: '9902953300' },
      ]),
      ownerWhatsappNumber: '9440416639',
      whatsappTestMode: false,
    };
    mockPrisma.companyProfile.findFirst.mockResolvedValue(profile);
    mockPrisma.companyProfile.findUnique.mockResolvedValue(profile);
  });

  it('skips sending if secondWeightKg is null and net weight is missing (first weight only)', async () => {
    const { notifyInternalKataCompleted } = await import('./whatsapp.service.js');
    const result = await notifyInternalKataCompleted({
      id: 'ticket_1',
      ticketNo: 101,
      vehicleNumber: 'TN28BF7423',
      firstWeightKg: 12000,
      secondWeightKg: null,
      netWeightKg: null,
      material: 'HUSK',
      partyName: 'SLV Enterprises',
    });

    expect(result.skipped).toBe(true);
    expect(result.error).toContain('Second weight not yet recorded');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('dispatches to internal alert recipients only upon 2nd weight completion', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(JSON.stringify({ return: true, request_id: 'req_123' })),
    });

    const { notifyInternalKataCompleted } = await import('./whatsapp.service.js');
    const result = await notifyInternalKataCompleted({
      id: 'ticket_2',
      ticketNo: 102,
      vehicleNumber: 'TN28BF7423',
      firstWeightKg: 11710,
      secondWeightKg: 32270,
      netWeightKg: 20560,
      material: 'PRE CLEANER DUST',
      partyName: 'SLV Enterprises',
      secondWeighedAt: new Date('2026-09-20T14:33:00Z'),
    });

    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalled();

    // Verify calls were made to internal recipients (9440416639, 9902953300)
    const calledUrls = mockFetch.mock.calls.map((call) => call[0].toString());
    const numbersSent = calledUrls.map((url) => {
      const u = new URL(url);
      return u.searchParams.get('numbers');
    });

    expect(numbersSent).toContain('919440416639');
    expect(numbersSent).toContain('919902953300');

    // Verify variables inside the query parameters
    const firstCallUrl = new URL(calledUrls[0]);
    expect(firstCallUrl.searchParams.get('message_id')).toBe('33711');
    const vars = firstCallUrl.searchParams.get('variables_values')?.split('|');
    expect(vars?.[0]).toBe('TN28BF7423'); // {{1}} Vehicle
    expect(vars?.[3]).toBe('SLV Enterprises'); // {{4}} Party
    expect(vars?.[4]).toBe('PRE CLEANER DUST'); // {{5}} Commodity
    expect(vars?.[5]).toBe('20,560 Kg'); // {{6}} Net Weight
  });

  it('handles edit updates by including (Updated) in party display', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(JSON.stringify({ return: true, request_id: 'req_edit_123' })),
    });

    const { notifyInternalKataCompleted } = await import('./whatsapp.service.js');
    const result = await notifyInternalKataCompleted(
      {
        id: 'ticket_3',
        ticketNo: 103,
        vehicleNumber: 'KA04BF7423',
        firstWeightKg: 10000,
        secondWeightKg: 25000,
        netWeightKg: 15000,
        material: 'TAMARIND SEED',
        partyName: 'Murali Traders',
        secondWeighedAt: new Date('2026-09-20T15:00:00Z'),
      },
      { isUpdate: true }
    );

    expect(result.ok).toBe(true);
    const calledUrl = new URL(mockFetch.mock.calls[0][0].toString());
    const vars = calledUrl.searchParams.get('variables_values')?.split('|');
    expect(vars?.[3]).toBe('Murali Traders (Updated)');
  });
});
