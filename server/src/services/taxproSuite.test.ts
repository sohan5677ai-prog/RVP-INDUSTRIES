import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPrisma = {
  deliveryChallan: {
    findUnique: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
  },
  stockIn: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  saleDispatch: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  party: {
    findMany: vi.fn(),
  },
  creditNote: {
    findMany: vi.fn(),
  },
  debitNote: {
    findMany: vi.fn(),
  },
  productTaxInfo: {
    findMany: vi.fn(),
  },
};

const mockCompany = {
  name: 'RVP INDUSTRIES PRIVATE LIMITED',
  gstin: '37AABCR1234F1Z5',
  address: 'Plot No. 12, Industrial Estate',
  pincode: '517247',
  city: 'Punganur',
  stateName: 'Andhra Pradesh',
  stateCode: 37,
  taxproGspId: null, // Mock mode (0 credit consumption)
  taxproGspSecret: null,
  taxproGstUser: null,
  taxproGstPass: null,
  taxproSandbox: true,
};

vi.mock('../lib/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../controllers/settings.controller.js', () => ({
  getCompanyProfileRow: vi.fn(() => Promise.resolve(mockCompany)),
}));
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { TaxproService } = await import('./taxpro.service.js');

describe('TaxPro GSP 5-Feature Compliance Suite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('1. Taxpayer Return Filing Status Tracker (GetTaxpayerFiling)', () => {
    it('returns simulated 12-month return filing history with 0 credit consumption', async () => {
      const gstin = '37AAAPL1234F1Z1';
      const result = await TaxproService.getTaxpayerFiling(gstin);

      expect(result.success).toBe(true);
      expect(result.gstin).toBe(gstin);
      expect(result.complianceStatus).toBe('REGULAR');
      expect(result.isSimulated).toBe(true);
      expect(Array.isArray(result.filings)).toBe(true);
      expect(result.filings.length).toBeGreaterThan(0);

      // Check structure of returns
      const gstr3b = result.filings.find((f: any) => f.ret_typ === 'GSTR3B');
      expect(gstr3b).toBeDefined();
      expect(gstr3b.status).toBe('Filed');
      expect(gstr3b.dof).toBeDefined();
      expect(gstr3b.arn).toContain('AA37');
    });

    it('rejects invalid GSTIN format with clear error', async () => {
      await expect(TaxproService.getTaxpayerFiling('INVALID_GSTIN')).rejects.toThrow(
        'Invalid GSTIN format'
      );
    });
  });

  describe('2. Delivery Challan E-Way Bill Validity Extension (Rule 55)', () => {
    it('successfully extends validity on an active delivery challan', async () => {
      const mockChallan = {
        id: 'dc-301',
        challanNumber: 'DC/26-27/005',
        ewbNumber: '241098765432',
        ewbStatus: 'GENERATED',
        ewbValidUpto: new Date('2026-08-10T12:00:00Z'),
        fromPlace: 'Punganur',
        fromStateCode: 37,
        fromPincode: 517247,
        distanceKm: 80,
      };

      mockPrisma.deliveryChallan.findUnique.mockResolvedValue(mockChallan);
      mockPrisma.deliveryChallan.update.mockImplementation(({ data }) =>
        Promise.resolve({ ...mockChallan, ...data })
      );

      const res = await TaxproService.extendDeliveryChallanValidity('dc-301', {
        vehicleNo: 'AP04TT5678',
        fromPlace: 'Madanapalle',
        fromState: 37,
        fromPincode: 517325,
        remainingDistance: 45,
        extnRsnCode: 1,
        extnRemarks: 'Vehicle punctured near Madanapalle',
      });

      expect(res.success).toBe(true);
      expect(res.newValidUpto).toBeInstanceOf(Date);
      expect(mockPrisma.deliveryChallan.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'dc-301' },
          data: expect.objectContaining({
            ewbValidUpto: expect.any(Date),
          }),
        })
      );
    });

    it('rejects extension on cancelled delivery challan', async () => {
      mockPrisma.deliveryChallan.findUnique.mockResolvedValue({
        id: 'dc-302',
        challanNumber: 'DC/26-27/006',
        ewbNumber: '241098765433',
        ewbStatus: 'CANCELLED',
      });

      await expect(
        TaxproService.extendDeliveryChallanValidity('dc-302', {
          vehicleNo: 'AP04TT5678',
          fromPlace: 'Punganur',
          fromState: 37,
          fromPincode: 517247,
          remainingDistance: 50,
        })
      ).rejects.toThrow('Cannot extend validity on a cancelled E-Way Bill');
    });
  });

  describe('3. Bulk GSTIN Audit Logic', () => {
    it('verifies GSTIN status and identifies name matches', async () => {
      const mockParty = {
        id: 'party-1',
        name: 'TEST ENTERPRISE PVT LTD',
        gstin: '29AAAAA0000A1Z5',
        type: 'BUYER',
        state: 'Karnataka',
      };

      const lookup = await TaxproService.lookupGstin(mockParty.gstin);
      expect(lookup.status).toBe('ACT');
      expect(lookup.legalName).toBe('TEST ENTERPRISE PVT LTD');
    });
  });
});
