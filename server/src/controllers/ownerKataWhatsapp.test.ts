import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPrisma = {
  whatsAppLog: {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  companyProfile: {
    findUnique: vi.fn(),
  },
  driverKataSubmission: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  saleDispatch: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
};

const mockDelivery = {
  confirmDelivery: vi.fn(),
};

const mockWaService = {
  sendSessionTextMessage: vi.fn().mockResolvedValue({ ok: true }),
  notifyDriverKataConfirmed: vi.fn().mockResolvedValue({ ok: true }),
  notifyDriverKataRejected: vi.fn().mockResolvedValue({ ok: true }),
  resolveAlertRecipients: vi.fn().mockResolvedValue(['9902953300']),
};

vi.mock('../lib/prisma.js', () => ({
  prisma: mockPrisma,
}));

vi.mock('../services/delivery.service.js', () => mockDelivery);

vi.mock('../services/whatsapp.service.js', () => ({
  ...mockWaService,
  whatsappService: {},
  normalizeWhatsAppNumber: (n: string) => n.replace(/\D/g, '').slice(-10),
  downloadWhatsAppMedia: vi.fn(),
  notifyDriverKataReceived: vi.fn(),
}));

vi.mock('../lib/gemini.js', () => ({
  parseTransportConfirmationText: vi.fn().mockResolvedValue(null),
  parseBuyerKataImage: vi.fn().mockResolvedValue(null),
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

async function postWebhook(body: unknown) {
  const res = {
    statusCode: 200,
    json: vi.fn(),
    status(code: number) {
      this.statusCode = code;
      return this;
    },
  };
  const req = { body, header: () => undefined };
  await handleWhatsAppWebhook(req as never, res as never);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return res;
}

describe('Owner WhatsApp Kata Approval Workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.FAST2SMS_WEBHOOK_SECRET;
    mockPrisma.whatsAppLog.findFirst.mockResolvedValue(null);
    mockPrisma.whatsAppLog.create.mockResolvedValue({ id: 'log1' });
    mockPrisma.companyProfile.findUnique.mockResolvedValue({ ownerWhatsappNumber: '9902953300' });
    mockWaService.resolveAlertRecipients.mockResolvedValue(['9902953300']);
  });

  it('handles "APPROVE <lorry>" from owner, calls confirmDelivery, and notifies driver and owner', async () => {
    const mockSubmission = {
      id: 'sub_123',
      status: 'PENDING',
      driverPhone: '9876543210',
      ocrBuyerKataKg: 24850,
      ocrLorryNumber: 'TN28BF7423',
      imageUrl: 'https://example.com/slip.jpg',
      saleDispatch: {
        id: 'disp_123',
        vehicleNumber: 'TN28BF7423',
        weightKg: 25000,
        driverPhone: '9876543210',
        saleOrder: {
          buyer: { name: 'Colourtex Industries' },
        },
      },
    };

    mockPrisma.driverKataSubmission.findMany.mockResolvedValue([mockSubmission]);
    mockDelivery.confirmDelivery.mockResolvedValue({ id: 'disp_123', status: 'DELIVERED' });

    const res = await postWebhook({
      webhook_type: 'incoming_message',
      from: '919902953300', // Authorized owner number
      text: 'APPROVE TN28BF7423',
    });

    expect(res.statusCode).toBe(200);

    // Verify confirmDelivery was called with OCR weight
    expect(mockDelivery.confirmDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchId: 'disp_123',
        buyerKataKg: 24850,
        submissionId: 'sub_123',
      })
    );

    // Verify driver was notified of delivery confirmation
    expect(mockWaService.notifyDriverKataConfirmed).toHaveBeenCalledWith(
      '9876543210',
      'TN28BF7423',
      'Colourtex Industries',
      150 // 25000 - 24850
    );

    // Verify owner received confirmation reply
    expect(mockWaService.sendSessionTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '919902953300',
        text: expect.stringContaining('Delivery Confirmed & Recorded!'),
      })
    );
  });

  it('handles "APPROVE <lorry> <weight>" to override the weight in kg', async () => {
    const mockSubmission = {
      id: 'sub_456',
      status: 'PENDING',
      driverPhone: '9876543210',
      ocrBuyerKataKg: 24800,
      ocrLorryNumber: 'TN28BF7423',
      imageUrl: 'https://example.com/slip.jpg',
      saleDispatch: {
        id: 'disp_456',
        vehicleNumber: 'TN28BF7423',
        weightKg: 25000,
        driverPhone: '9876543210',
        saleOrder: {
          buyer: { name: 'Colourtex Industries' },
        },
      },
    };

    mockPrisma.driverKataSubmission.findMany.mockResolvedValue([mockSubmission]);
    mockDelivery.confirmDelivery.mockResolvedValue({ id: 'disp_456', status: 'DELIVERED' });

    await postWebhook({
      webhook_type: 'incoming_message',
      from: '919902953300',
      text: 'APPROVE TN28BF7423 24900',
    });

    // Verify confirmDelivery was called with override weight (24900 kg)
    expect(mockDelivery.confirmDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchId: 'disp_456',
        buyerKataKg: 24900,
      })
    );
  });

  it('handles "APPROVE <lorry> <weight>" with angle brackets and parenthetical notes', async () => {
    const mockSubmission = {
      id: 'sub_5359',
      status: 'PENDING',
      driverPhone: '9902953300',
      ocrBuyerKataKg: 34640,
      ocrLorryNumber: 'TN29CJ5359',
      imageUrl: 'https://example.com/slip.jpg',
      saleDispatch: {
        id: 'disp_5359',
        vehicleNumber: 'TN29CJ5359',
        weightKg: 35000,
        driverPhone: '9902953300',
        saleOrder: {
          buyer: { name: 'Tirupati Agro Industries' },
        },
      },
    };

    mockPrisma.driverKataSubmission.findMany.mockResolvedValue([mockSubmission]);
    mockDelivery.confirmDelivery.mockResolvedValue({ id: 'disp_5359', status: 'DELIVERED' });

    // Test exact message the user sent: APPROVE TN29CJ5359 <34820> (override weight)
    await postWebhook({
      webhook_type: 'incoming_message',
      from: '919902953300',
      text: 'APPROVE TN29CJ5359 <34820> (override weight)',
    });

    expect(mockDelivery.confirmDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchId: 'disp_5359',
        buyerKataKg: 34820,
      })
    );

    // Test with comma and kg unit: APPROVE TN29CJ5359 34,820 kg
    vi.clearAllMocks();
    mockPrisma.driverKataSubmission.findMany.mockResolvedValue([mockSubmission]);
    mockDelivery.confirmDelivery.mockResolvedValue({ id: 'disp_5359', status: 'DELIVERED' });

    await postWebhook({
      webhook_type: 'incoming_message',
      from: '919902953300',
      text: 'APPROVE TN29CJ5359 34,820 kg',
    });

    expect(mockDelivery.confirmDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchId: 'disp_5359',
        buyerKataKg: 34820,
      })
    );

    // Test with tonnes and MT unit: APPROVE TN29CJ5359 34.82 MT
    vi.clearAllMocks();
    mockPrisma.driverKataSubmission.findMany.mockResolvedValue([mockSubmission]);
    mockDelivery.confirmDelivery.mockResolvedValue({ id: 'disp_5359', status: 'DELIVERED' });

    await postWebhook({
      webhook_type: 'incoming_message',
      from: '919902953300',
      text: 'APPROVE TN29CJ5359 34.82 MT',
    });

    expect(mockDelivery.confirmDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchId: 'disp_5359',
        buyerKataKg: 34820,
      })
    );
  });

  it('handles "REJECT <lorry> <reason>", marks submission REJECTED, and notifies driver', async () => {
    const mockSubmission = {
      id: 'sub_789',
      status: 'PENDING',
      driverPhone: '9876543210',
      ocrBuyerKataKg: 24800,
      saleDispatch: {
        id: 'disp_789',
        vehicleNumber: 'TN28BF7423',
        weightKg: 25000,
        saleOrder: {
          buyer: { name: 'Colourtex Industries' },
        },
      },
    };

    mockPrisma.driverKataSubmission.findMany.mockResolvedValue([mockSubmission]);
    mockPrisma.driverKataSubmission.update.mockResolvedValue({
      ...mockSubmission,
      status: 'REJECTED',
    });

    await postWebhook({
      webhook_type: 'incoming_message',
      from: '919902953300',
      text: 'REJECT TN28BF7423 Slip photo is blurry',
    });

    // Verify submission was updated to REJECTED with reason
    expect(mockPrisma.driverKataSubmission.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sub_789' },
        data: expect.objectContaining({
          status: 'REJECTED',
          rejectionReason: 'Slip photo is blurry',
        }),
      })
    );

    // Verify driver was notified to resubmit
    expect(mockWaService.notifyDriverKataRejected).toHaveBeenCalledWith(
      '9876543210',
      'TN28BF7423',
      'Slip photo is blurry'
    );

    // Verify owner was sent rejection confirmation
    expect(mockWaService.sendSessionTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '919902953300',
        text: expect.stringContaining('Kata Slip Rejected'),
      })
    );
  });

  it('handles "REJECT <lorry> <reason>" with angle brackets and parenthetical notes', async () => {
    const mockSubmission = {
      id: 'sub_789',
      status: 'PENDING',
      driverPhone: '9876543210',
      ocrBuyerKataKg: 24800,
      saleDispatch: {
        id: 'disp_789',
        vehicleNumber: 'TN28BF7423',
        weightKg: 25000,
        saleOrder: { buyer: { name: 'Colourtex Industries' } },
      },
    };

    mockPrisma.driverKataSubmission.findMany.mockResolvedValue([mockSubmission]);
    mockPrisma.driverKataSubmission.update.mockResolvedValue({
      ...mockSubmission,
      status: 'REJECTED',
    });

    await postWebhook({
      webhook_type: 'incoming_message',
      from: '919902953300',
      text: 'REJECT TN28BF7423 <unclear photo> (ask driver to resend)',
    });

    expect(mockPrisma.driverKataSubmission.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sub_789' },
        data: expect.objectContaining({
          status: 'REJECTED',
          rejectionReason: 'unclear photo',
        }),
      })
    );
  });

  it('ignores commands from unauthorized senders', async () => {
    const res = await postWebhook({
      webhook_type: 'incoming_message',
      from: '918888888888', // Non-owner random number
      text: 'APPROVE TN28BF7423',
    });

    expect(res.statusCode).toBe(200);
    expect(mockDelivery.confirmDelivery).not.toHaveBeenCalled();
    expect(mockWaService.notifyDriverKataConfirmed).not.toHaveBeenCalled();
  });
});
