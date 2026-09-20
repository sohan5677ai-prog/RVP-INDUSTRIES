import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateWeighbridgeSlipJpeg } from '../lib/weighbridgeSlipImage.js';

const mockFindUnique = vi.fn();
const mockFindFirst = vi.fn();
const mockUpdate = vi.fn();
const mockPartyFindFirst = vi.fn();

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    weighbridgeTicket: {
      findUnique: (...args: any[]) => mockFindUnique(...args),
      update: (...args: any[]) => mockUpdate(...args),
    },
    companyProfile: {
      findFirst: (...args: any[]) => mockFindFirst(...args),
    },
    party: {
      findFirst: (...args: any[]) => mockPartyFindFirst(...args),
    },
    whatsAppLog: {
      create: vi.fn().mockResolvedValue({ id: 'log-1' }),
    },
  },
}));

const mockSendWeighbridgePaidSlip = vi.fn().mockResolvedValue({ ok: true });

vi.mock('../services/whatsapp.service.js', () => ({
  sendWeighbridgePaidSlip: (...args: any[]) => mockSendWeighbridgePaidSlip(...args),
  sendWeighbridgeSecondWeightReminder: vi.fn(),
  sendDriverSecondWeightReminder: vi.fn(),
  sendHamaliSecondWeightReminder: vi.fn(),
  sendWeighbridgeDriverUnloadedSlip: vi.fn(),
  notifyInternalKataCompleted: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../lib/upload.js', () => ({
  uploadBufferToStorage: vi.fn().mockResolvedValue('https://example.com/slip.jpg'),
}));

const { verifyTicketPaymentHandler, sendTicketSlipWhatsappHandler } = await import('./weighbridge.controller.js');

describe('Weighbridge Release Slip & Exemption Rules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirst.mockResolvedValue({
      companyVehicles: 'AP39UX9105, AP39UX9106',
    });
  });

  describe('generateWeighbridgeSlipJpeg', () => {
    it('generates a valid high-resolution JPEG slip with official RECEIVED stamp', async () => {
      const buffer = await generateWeighbridgeSlipJpeg({
        ticketNo: 157,
        vehicleNumber: 'AP39UX9105',
        partyName: 'SRI VENKATESWARA TRADERS',
        material: 'TAMARIND SEED',
        firstWeightKg: 28450,
        secondWeightKg: 10250,
        netWeightKg: 18200,
        amount: 250,
        createdAt: new Date('2026-09-20T10:30:00Z'),
      });

      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(10000);
      // JPEG magic numbers: 0xFF, 0xD8, 0xFF
      expect(buffer[0]).toBe(0xff);
      expect(buffer[1]).toBe(0xd8);
      expect(buffer[2]).toBe(0xff);
    });
  });

  describe('verifyTicketPaymentHandler', () => {
    it('automatically marks KNM company vehicles as EXEMPT with ₹0 Kata fee and skips WhatsApp', async () => {
      mockFindUnique.mockResolvedValue({
        id: 't-knm',
        ticketNo: 101,
        vehicleNumber: 'AP39UX9105',
        amount: 0,
        partyName: 'KNM Plant',
        partyMobile: '9440416639',
        status: 'COMPLETED',
      });

      mockUpdate.mockImplementation(({ data }) => Promise.resolve({ id: 't-knm', ...data }));

      const req: any = {
        params: { id: 't-knm' },
        body: { reference: 'CASH', sendWhatsapp: true },
        user: { name: 'Kata Operator' },
      };

      const res: any = {
        json: vi.fn(),
      };

      await verifyTicketPaymentHandler(req, res);

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 't-knm' },
          data: expect.objectContaining({
            paymentStatus: 'NOT_REQUIRED',
            paidAmount: 0,
            paymentReference: 'KNM_EXEMPT',
          }),
        })
      );

      expect(mockSendWeighbridgePaidSlip).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          whatsapp: expect.objectContaining({
            ok: false,
            skipped: true,
          }),
        })
      );
    });

    it('automatically marks internal storage transfers as EXEMPT and skips WhatsApp', async () => {
      mockFindUnique.mockResolvedValue({
        id: 't-transfer',
        ticketNo: 102,
        vehicleNumber: 'AP04TU1234',
        amount: 0,
        isStorageTransfer: true,
        storageLocation: 'PGR COLD',
        transferDirection: 'RVP_TO_STORAGE',
        status: 'COMPLETED',
      });

      mockUpdate.mockImplementation(({ data }) => Promise.resolve({ id: 't-transfer', ...data }));

      const req: any = {
        params: { id: 't-transfer' },
        body: { sendWhatsapp: true },
        user: { name: 'Kata Operator' },
      };

      const res: any = { json: vi.fn() };

      await verifyTicketPaymentHandler(req, res);

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 't-transfer' },
          data: expect.objectContaining({
            paymentStatus: 'NOT_REQUIRED',
            paidAmount: 0,
            paymentReference: 'INTERNAL_TRANSFER',
          }),
        })
      );

      expect(mockSendWeighbridgePaidSlip).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          whatsapp: expect.objectContaining({
            ok: false,
            skipped: true,
          }),
        })
      );
    });

    it('does not send WhatsApp release slip for outward sales to BUYER parties', async () => {
      mockFindUnique.mockResolvedValue({
        id: 't-sale',
        ticketNo: 103,
        vehicleNumber: 'TN02AB9999',
        amount: 300,
        partyName: 'AMMAN ENTERPRISES',
        partyMobile: '9876543210',
        status: 'COMPLETED',
      });

      mockPartyFindFirst.mockResolvedValue({
        type: 'BUYER',
      });

      mockUpdate.mockImplementation(({ data }) => Promise.resolve({ id: 't-sale', ...data }));

      const req: any = {
        params: { id: 't-sale' },
        body: { amount: 300, reference: 'CASH', sendWhatsapp: true },
        user: { name: 'Kata Operator' },
      };

      const res: any = { json: vi.fn() };

      await verifyTicketPaymentHandler(req, res);

      expect(mockSendWeighbridgePaidSlip).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          whatsapp: expect.objectContaining({
            ok: false,
            skipped: true,
            error: expect.stringContaining('inward purchases'),
          }),
        })
      );
    });

    it('sends stamped Kata certificate to driver via WhatsApp for inward purchases', async () => {
      const ticketObj = {
        id: 't-purchase',
        ticketNo: 104,
        vehicleNumber: 'KA01CD5555',
        amount: 250,
        partyName: 'BALAJI AGRO SUPPLIERS',
        partyMobile: '9876543210',
        status: 'COMPLETED',
      };
      mockFindUnique.mockResolvedValue(ticketObj);

      mockPartyFindFirst.mockResolvedValue({
        type: 'SUPPLIER',
      });

      mockUpdate.mockImplementation(({ data }) => Promise.resolve({ ...ticketObj, ...data }));

      const req: any = {
        params: { id: 't-purchase' },
        body: {
          amount: 250,
          reference: 'UPI',
          driverMobile: '9876543210',
          language: 'TE',
          sendWhatsapp: true,
        },
        user: { name: 'Kata Operator' },
      };

      const res: any = { json: vi.fn() };

      await verifyTicketPaymentHandler(req, res);

      expect(mockSendWeighbridgePaidSlip).toHaveBeenCalledWith(
        expect.objectContaining({
          to: '9876543210',
          ticketNo: 104,
          imageUrl: expect.stringMatching(/slip\.(jpg|png)|storage/i),
        })
      );
    });
  });

  describe('sendTicketSlipWhatsappHandler', () => {
    it('rejects sending release slip for KNM vehicles', async () => {
      mockFindUnique.mockResolvedValue({
        id: 't-knm-slip',
        vehicleNumber: 'AP39UX9105',
        status: 'COMPLETED',
      });

      const req: any = {
        params: { id: 't-knm-slip' },
        body: { driverMobile: '9876543210' },
      };
      const res: any = { json: vi.fn() };

      await expect(sendTicketSlipWhatsappHandler(req, res)).rejects.toThrow(/KNM company vehicles are exempt/);
    });

    it('rejects sending release slip for storage transfers', async () => {
      mockFindUnique.mockResolvedValue({
        id: 't-tr-slip',
        vehicleNumber: 'AP04TU1234',
        isStorageTransfer: true,
        status: 'COMPLETED',
      });

      const req: any = {
        params: { id: 't-tr-slip' },
        body: { driverMobile: '9876543210' },
      };
      const res: any = { json: vi.fn() };

      await expect(sendTicketSlipWhatsappHandler(req, res)).rejects.toThrow(/Internal storage transfers are exempt/);
    });

    it('rejects sending release slip for outward sales', async () => {
      mockFindUnique.mockResolvedValue({
        id: 't-sale-slip',
        vehicleNumber: 'TN02AB9999',
        partyName: 'AMMAN ENTERPRISES',
        status: 'COMPLETED',
      });

      mockPartyFindFirst.mockResolvedValue({
        type: 'BUYER',
      });

      const req: any = {
        params: { id: 't-sale-slip' },
        body: { driverMobile: '9876543210' },
      };
      const res: any = { json: vi.fn() };

      await expect(sendTicketSlipWhatsappHandler(req, res)).rejects.toThrow(/only for inward purchases/);
    });
  });
});
