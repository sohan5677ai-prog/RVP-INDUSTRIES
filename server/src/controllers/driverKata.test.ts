import { describe, it, expect, vi, beforeEach } from 'vitest';

const dispatchFindUnique = vi.fn();
const dispatchUpdate = vi.fn();
const dispatchFindMany = vi.fn();
const orderFindUnique = vi.fn();
const orderUpdate = vi.fn();
const receiptCount = vi.fn();
const submissionUpdate = vi.fn();

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    saleDispatch: {
      findUnique: (...a: unknown[]) => dispatchFindUnique(...a),
      update: (...a: unknown[]) => dispatchUpdate(...a),
      findMany: (...a: unknown[]) => dispatchFindMany(...a),
    },
    saleOrder: {
      findUnique: (...a: unknown[]) => orderFindUnique(...a),
      update: (...a: unknown[]) => orderUpdate(...a),
    },
    receipt: {
      count: (...a: unknown[]) => receiptCount(...a),
    },
    driverKataSubmission: {
      update: (...a: unknown[]) => submissionUpdate(...a),
    },
    productTaxInfo: {
      findUnique: vi.fn().mockResolvedValue({ gstRate: 5 }),
    },
    $transaction: async (fn: any) => fn({
      saleDispatch: { update: dispatchUpdate, findMany: dispatchFindMany },
      saleOrder: { update: orderUpdate },
      driverKataSubmission: { update: submissionUpdate },
    }),
  },
}));

vi.mock('../controllers/inventory.controller.js', () => ({
  computePappuOrderMargins: vi.fn().mockResolvedValue([]),
}));

vi.mock('../lib/cache.js', () => ({
  clearCache: vi.fn(),
}));

const { confirmDelivery } = await import('../services/delivery.service.js');

describe('confirmDelivery service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    receiptCount.mockResolvedValue(0);
  });

  it('marks a dispatch DELIVERED and computes shortage and credit note', async () => {
    const mockDispatch = {
      id: 'disp1',
      status: 'DISPATCHED',
      weightKg: 25000,
      dispatchDate: new Date('2026-09-01'),
      receivedDate: null,
      saleOrder: {
        id: 'so1',
        product: 'PAPPU',
        ratePerKg: 100,
        gstExempt: false,
        tonnageKg: 25000,
        buyer: { name: 'Test Buyer' },
      },
    };

    dispatchFindUnique.mockResolvedValue(mockDispatch);
    dispatchUpdate.mockResolvedValue({ ...mockDispatch, status: 'DELIVERED', buyerKataKg: 24850, shortageKg: 150 });
    dispatchFindMany.mockResolvedValue([{ id: 'disp1', status: 'DELIVERED', weightKg: 25000 }]);
    orderFindUnique.mockResolvedValue({ product: 'PAPPU', costFrozenAt: new Date() });

    const result = await confirmDelivery({
      dispatchId: 'disp1',
      buyerKataKg: 24850,
      deliveredDate: new Date('2026-09-02'),
      submissionId: 'sub1',
      confirmedBy: 'TestUser',
    });

    expect(dispatchUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'disp1' },
        data: expect.objectContaining({
          status: 'DELIVERED',
          buyerKataKg: 24850,
          shortageKg: 150,
          // Shortage is 150 kg * Rs 100 = Rs 15,000 + 5% GST (Rs 750) = Rs 15,750
          creditNoteAmount: 15750,
        }),
      })
    );

    // Order rolled forward to DELIVERED
    expect(orderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'so1' },
        data: { status: 'DELIVERED' },
      })
    );

    // Driver kata submission marked APPROVED
    expect(submissionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sub1' },
        data: expect.objectContaining({
          status: 'APPROVED',
          confirmedKg: 24850,
          confirmedBy: 'TestUser',
        }),
      })
    );

    expect(result.status).toBe('DELIVERED');
  });

  it('allows buyer kata greater than dispatched weight (e.g. moisture gain) with 0 shortage', async () => {
    const mockDispatch = {
      id: 'disp1',
      status: 'DISPATCHED',
      weightKg: 25000,
      dispatchDate: new Date('2026-09-01'),
      receivedDate: null,
      saleOrder: {
        id: 'so1',
        product: 'PAPPU',
        ratePerKg: 100,
        gstExempt: false,
        tonnageKg: 25000,
        buyer: { name: 'Test Buyer' },
      },
    };

    dispatchFindUnique.mockResolvedValue(mockDispatch);
    dispatchUpdate.mockResolvedValue({ ...mockDispatch, status: 'DELIVERED', buyerKataKg: 25500, shortageKg: 0, creditNoteAmount: 0 });
    dispatchFindMany.mockResolvedValue([{ id: 'disp1', status: 'DELIVERED', weightKg: 25000 }]);
    orderFindUnique.mockResolvedValue({ product: 'PAPPU', costFrozenAt: new Date() });

    const result = await confirmDelivery({
      dispatchId: 'disp1',
      buyerKataKg: 25500, // Greater than dispatched (moisture gain)
      deliveredDate: new Date('2026-09-02'),
    });

    expect(dispatchUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'disp1' },
        data: expect.objectContaining({
          status: 'DELIVERED',
          buyerKataKg: 25500,
          shortageKg: 0,
          creditNoteAmount: 0,
        }),
      })
    );

    expect(result.status).toBe('DELIVERED');
  });

  it('does not revert a short-closed order to PARTIAL upon delivery', async () => {
    const mockDispatch = {
      id: 'disp_short',
      status: 'DISPATCHED',
      weightKg: 29500,
      dispatchDate: new Date('2026-09-01'),
      receivedDate: null,
      saleOrder: {
        id: 'so_short',
        product: 'HUSK',
        ratePerKg: 10.3,
        gstExempt: false,
        tonnageKg: 30000,
        closedAt: new Date('2026-09-01'),
        closeReason: 'Final lorry landed 500 kg under the booked tonnage - within the 2% tolerance',
        buyer: { name: 'Kraft Food Tech India LLP' },
      },
    };

    dispatchFindUnique.mockResolvedValue(mockDispatch);
    dispatchUpdate.mockResolvedValue({ ...mockDispatch, status: 'DELIVERED', buyerKataKg: 29500, shortageKg: 0, creditNoteAmount: 0 });
    dispatchFindMany.mockResolvedValue([{ id: 'disp_short', status: 'DELIVERED', weightKg: 29500 }]);
    orderFindUnique.mockResolvedValue({ product: 'HUSK', costFrozenAt: null });

    const result = await confirmDelivery({
      dispatchId: 'disp_short',
      buyerKataKg: 29500,
      deliveredDate: new Date('2026-09-02'),
    });

    expect(orderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'so_short' },
        data: expect.objectContaining({
          status: 'DELIVERED',
        }),
      })
    );
    expect(result.status).toBe('DELIVERED');
  });
});
