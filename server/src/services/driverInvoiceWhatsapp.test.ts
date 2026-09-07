import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPrisma = {
  saleDispatch: {
    findUnique: vi.fn(),
  },
  whatsAppLog: {
    findFirst: vi.fn(),
  },
};

const mockWhatsappService = {
  notifyDispatchDriver: vi.fn(),
};

vi.mock('../lib/prisma.js', () => ({
  prisma: mockPrisma,
}));

vi.mock('./whatsapp.service.js', () => ({
  whatsappService: mockWhatsappService,
  resolveInternalCopyRecipients: vi.fn().mockResolvedValue([]),
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../lib/orderAddress.js', () => ({
  resolveOrderEffectiveDetails: vi.fn().mockResolvedValue({
    effectivePhone: '9876543210',
    effectivePhone2: null,
    effectiveLocationLink: '21.13,72.83',
    effectiveAddress: 'Some Street',
    effectiveCity: 'Surat',
    effectiveDestination: 'Surat',
  }),
  resolveOrderBuyerAddress: vi.fn(),
}));

const { sendDriverLocationIfNotSent } = await import('./dispatchWhatsapp.service.js');

describe('sendDriverLocationIfNotSent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips when dispatch has no driver phone', async () => {
    mockPrisma.saleDispatch.findUnique.mockResolvedValue({
      id: 'disp-1',
      driverPhone: null,
    });

    const res = await sendDriverLocationIfNotSent('disp-1');
    expect(res.status).toBe('skipped');
    expect(res.error).toBe('No driver phone on this dispatch');
    expect(mockPrisma.whatsAppLog.findFirst).not.toHaveBeenCalled();
    expect(mockWhatsappService.notifyDispatchDriver).not.toHaveBeenCalled();
  });

  it('does NOT double-send when a message was already SENT', async () => {
    mockPrisma.saleDispatch.findUnique.mockResolvedValue({
      id: 'disp-2',
      driverPhone: '9943262021',
    });

    mockPrisma.whatsAppLog.findFirst.mockResolvedValue({
      id: 'log-1',
      status: 'SENT',
      template: 'DISPATCH_DRIVER',
    });

    const res = await sendDriverLocationIfNotSent('disp-2');
    expect(res.status).toBe('sent');
    expect(res.error).toBeNull();
    expect(mockWhatsappService.notifyDispatchDriver).not.toHaveBeenCalled();
  });

  it('sends to driver when not sent previously', async () => {
    // First findUnique in sendDriverLocationIfNotSent
    mockPrisma.saleDispatch.findUnique
      .mockResolvedValueOnce({
        id: 'disp-3',
        driverPhone: '9943262021',
      })
      // Second findUnique in resendDispatchDriverWhatsApp
      .mockResolvedValueOnce({
        id: 'disp-3',
        driverPhone: '9943262021',
        driverName: 'Driver Ji',
        vehicleNumber: 'GJ05AB1234',
        weightKg: 25000,
        saleOrder: {
          product: 'PAPPU',
          buyer: {
            name: 'Test Buyer',
            addresses: [],
          },
        },
      });

    // No existing SENT row
    mockPrisma.whatsAppLog.findFirst.mockResolvedValue(null);

    mockWhatsappService.notifyDispatchDriver.mockResolvedValue({ ok: true });

    const res = await sendDriverLocationIfNotSent('disp-3');
    expect(res.status).toBe('sent');
    expect(mockWhatsappService.notifyDispatchDriver).toHaveBeenCalledTimes(1);
    expect(mockWhatsappService.notifyDispatchDriver).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'disp-3',
        driverPhone: '9943262021',
        vehicleNumber: 'GJ05AB1234',
      }),
      expect.objectContaining({
        name: 'Test Buyer',
      }),
      expect.objectContaining({
        product: 'PAPPU',
      })
    );
  });
});
