import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    companyProfile: {
      findUnique: vi.fn().mockResolvedValue({
        alertRecipients: JSON.stringify([
          { name: 'Shabari', phone: '9902953300' },
          { name: 'Partner One', phone: '9876543210' },
        ]),
        ownerWhatsappNumber: '9902953300',
      }),
      findFirst: vi.fn(),
    },
    settings: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    whatsAppLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('Lorry Payment WhatsApp Routing', () => {
  let fetchMock: any;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WHATSAPP_ENABLED = 'true';
    process.env.WHATSAPP_TEST_MODE = 'false';
    process.env.FAST2SMS_API_KEY = 'test_key';
    process.env.FAST2SMS_PHONE_NUMBER_ID = 'phone_123';
    process.env.FAST2SMS_TMPL_PAYMENT_SENT = '1001';
    process.env.FAST2SMS_TMPL_PAYMENT_SENT_TEXT = '1002';
    process.env.FAST2SMS_TMPL_LORRY_PAYMENT = '1003';
    process.env.FAST2SMS_TMPL_LORRY_PAYMENT_TEXT = '1004';

    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ return: true, request_id: 'req_123' }),
    });
    global.fetch = fetchMock;
  });

  it('exports KNM_TRANSPORT_WHATSAPP_NUMBER as 9440416639 and resolves normalized 919440416639', async () => {
    const { KNM_TRANSPORT_WHATSAPP_NUMBER, resolveKnmTransportRecipient } = await import('./whatsapp.service.js');
    expect(KNM_TRANSPORT_WHATSAPP_NUMBER).toBe('9440416639');
    expect(resolveKnmTransportRecipient()).toBe('919440416639');
  });

  it('sends lorry payment messages ONLY to driver and Shabari, omitting other internal alert recipients', async () => {
    const { whatsappService } = await import('./whatsapp.service.js');

    const payment = {
      id: 'pay-123',
      amount: 50000,
      date: new Date('2026-09-07'),
      reference: 'UTR12345',
      screenshotUrl: null,
    };

    const recipient = {
      name: 'Driver Kumar (Lorry TN28BF7498)',
      phone: '9848022338',
      phone2: null,
      waLanguage: 'EN' as const,
    };

    await whatsappService.notifyPaymentSent(payment, recipient, { isLorryPayment: true });

    const calledUrls: string[] = fetchMock.mock.calls.map((c: any) => c[0]);
    const messagedNumbers = calledUrls
      .map((u) => {
        const url = new URL(u);
        return url.searchParams.get('numbers');
      })
      .filter(Boolean);

    // Must include the driver (normalized to 919848022338)
    expect(messagedNumbers).toContain('919848022338');
    // Must include Shabari copy (normalized to 919902953300)
    expect(messagedNumbers).toContain('919902953300');
    // Must NOT send to other alert members (Partner One: 9876543210)
    expect(messagedNumbers).not.toContain('919876543210');
    // Exactly 2 calls: Driver + Shabari
    expect(calledUrls).toHaveLength(2);
  });

  it('for KNM Transport, routes payment message to Reddy (9440416639) and Shabari, never the driver', async () => {
    const { whatsappService } = await import('./whatsapp.service.js');

    const payment = {
      id: 'pay-knm-1',
      amount: 45000,
      date: new Date('2026-09-07'),
      reference: 'NEFT9988',
      screenshotUrl: null,
    };

    const recipient = {
      name: 'KNM Transport - Lorry AP39UX9105',
      phone: '9440416639',
      phone2: null,
      waLanguage: 'EN' as const,
    };

    await whatsappService.notifyPaymentSent(payment, recipient, { isLorryPayment: true, isKnm: true });

    const calledUrls: string[] = fetchMock.mock.calls.map((c: any) => c[0]);
    const messagedNumbers = calledUrls
      .map((u) => {
        const url = new URL(u);
        return url.searchParams.get('numbers');
      })
      .filter(Boolean);

    // Reddy (9440416639 normalized to 919440416639)
    expect(messagedNumbers).toContain('919440416639');
    // Shabari (9902953300 normalized to 919902953300)
    expect(messagedNumbers).toContain('919902953300');
    // Drivers or random phones must not be messaged
    expect(messagedNumbers).not.toContain('919848022338');
    expect(messagedNumbers).not.toContain('919876543210');
    expect(calledUrls).toHaveLength(2);
  });

  it('for KNM Transport lorry summary/receipt, routes to Reddy (9440416639) + Shabari', async () => {
    const { whatsappService } = await import('./whatsapp.service.js');

    const details = {
      date: new Date('2026-09-07'),
      lorryNumber: 'AP39UX9105',
      destination: 'Surat',
      grossFreight: 45000,
      kata: 0,
      hamali: 0,
      otherDeductions: 0,
      netPayable: 45000,
      amountPaid: 45000,
      reference: 'BANK',
      balance: 0,
      isKnm: true,
    };

    await whatsappService.sendLorryPaymentSummary(details, '9440416639');

    const calledUrls: string[] = fetchMock.mock.calls.map((c: any) => c[0]);
    const messagedNumbers = calledUrls
      .map((u) => {
        const url = new URL(u);
        return url.searchParams.get('numbers');
      })
      .filter(Boolean);

    expect(messagedNumbers).toContain('919440416639');
    expect(messagedNumbers).toContain('919902953300');
    expect(calledUrls).toHaveLength(2);
  });

  it('for non-lorry payments, sends to party + all internal alert members as usual', async () => {
    const { whatsappService } = await import('./whatsapp.service.js');

    const payment = {
      id: 'pay-supp-1',
      amount: 100000,
      date: new Date('2026-09-07'),
      reference: 'RTGS111',
      screenshotUrl: null,
    };

    const recipient = {
      name: 'Farmer Srinivas',
      phone: '9123456780',
      phone2: null,
      waLanguage: 'TE' as const,
    };

    await whatsappService.notifyPaymentSent(payment, recipient, { isLorryPayment: false });

    const calledUrls: string[] = fetchMock.mock.calls.map((c: any) => c[0]);
    const messagedNumbers = calledUrls
      .map((u) => {
        const url = new URL(u);
        return url.searchParams.get('numbers');
      })
      .filter(Boolean);

    // Party
    expect(messagedNumbers).toContain('919123456780');
    // Shabari and Partner One both receive internal copies
    expect(messagedNumbers).toContain('919902953300');
    expect(messagedNumbers).toContain('919876543210');
  });
});
