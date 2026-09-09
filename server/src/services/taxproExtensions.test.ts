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
  consolidatedEwb: {
    create: vi.fn(),
  },
  saleDispatch: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
  },
  partyAddress: {
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
  dispatchFromAddress1: 'Factory Campus, Punganur Road',
  dispatchFromPlace: 'Punganur',
  dispatchFromPincode: '517247',
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
const { resolveEwbDistance } = await import('./ewbDistance.service.js');

describe('TaxPro GSP Extensions (Sandbox / Mock Safety)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('1. GSTIN Lookup & Verification', () => {
    it('successfully looks up and parses GSTIN in sandbox/mock mode without hitting production', async () => {
      const gstin = '29ABCDE1234F1Z5';
      const result = await TaxproService.lookupGstin(gstin);

      expect(result.success).toBe(true);
      expect(result.gstin).toBe(gstin);
      expect(result.status).toBe('ACT');
      expect(result.legalName).toBeDefined();
      expect(result.pincode).toBeDefined();
      expect(result.message).toContain('mock');
    });

    it('throws error for invalid GSTIN format before any network call', async () => {
      await expect(TaxproService.lookupGstin('INVALID_GSTIN')).rejects.toThrow(
        /Invalid GSTIN format/i,
      );
    });
  });

  describe('2. Official PIN-to-PIN Distance', () => {
    it('returns null for invalid 5-digit pincodes', async () => {
      const dist = await TaxproService.getOfficialDistance('12345', '560001');
      expect(dist).toBeNull();
    });

    it('resolveEwbDistance attempts official distance before fallback routing', async () => {
      const mockDispatch = {
        id: 'disp-001',
        ewbDistance: null,
        saleOrder: {
          buyerId: 'b-1',
          buyerPincode: '560058',
          buyer: {
            pincode: '560058',
            addresses: [{ id: 'addr-1', pincode: '560058', isDefault: true, address1: 'Main St', city: 'Bengaluru', state: 'Karnataka' }],
          },
        },
      };

      mockPrisma.saleDispatch.findUnique.mockResolvedValue(mockDispatch);
      (mockPrisma as any).saleDispatch.findFirst = vi.fn().mockResolvedValue(null);

      // Mock getOfficialDistance returning 185 km
      const spy = vi.spyOn(TaxproService, 'getOfficialDistance').mockResolvedValue(185);

      const result = await resolveEwbDistance('disp-001');
      expect(spy).toHaveBeenCalledWith('517247', '560058');
      expect(result).not.toBeNull();
      expect(result?.km).toBe(185);
      expect(result?.source).toBe('official');

      spy.mockRestore();
    });
  });

  describe('3. Delivery Challan E-Way Bill (CHL)', () => {
    it('generates Delivery Challan EWB in mock mode and updates the database record', async () => {
      const mockChallan = {
        id: 'dc-101',
        challanNumber: 'DC/26-27/001',
        challanDate: new Date('2026-09-09'),
        challanType: 'JOB_WORK',
        subType: 'JOB_WORK',
        fromGstin: '37AABCR1234F1Z5',
        fromName: 'RVP INDUSTRIES PRIVATE LIMITED',
        fromAddress: 'Factory Campus, Punganur Road',
        fromPlace: 'Punganur',
        fromPincode: '517247',
        fromStateCode: 37,
        toGstin: '37XYZAB1111H1Z2',
        toName: 'GRINDING JOB WORKERS',
        toAddress: 'Job Work Industrial Park',
        toPlace: 'Tirupati',
        toPincode: '517501',
        toStateCode: 37,
        totalValue: 125000,
        cgstAmount: 3125,
        sgstAmount: 3125,
        igstAmount: 0,
        distanceKm: 85,
        vehicleNumber: 'AP04TU1234',
        status: 'ISSUED',
        ewbNumber: null,
        ewbStatus: null,
        items: [
          {
            productName: 'Raw Tamarind Seed for De-hulling',
            hsnCode: '120799',
            quantity: 5000,
            unit: 'KGS',
            taxableAmount: 125000,
            gstRate: 5,
          },
        ],
      };

      mockPrisma.deliveryChallan.findUnique.mockResolvedValue(mockChallan);
      mockPrisma.deliveryChallan.update.mockImplementation(({ data }) =>
        Promise.resolve({ ...mockChallan, ...data }),
      );

      const res = await TaxproService.generateDeliveryChallanEwb('dc-101', {
        vehicleNumber: 'AP04TU1234',
        transDistance: 85,
      });

      expect(res.success).toBe(true);
      expect(res.ewbNumber).toBeDefined();
      expect(res.ewbValidUpto).toBeInstanceOf(Date);
      expect(res.distance).toBe(85);
      expect(mockPrisma.deliveryChallan.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'dc-101' },
          data: expect.objectContaining({
            ewbStatus: 'GENERATED',
            distanceKm: 85,
          }),
        }),
      );
    });

    it('cancels Delivery Challan EWB and updates database status to CANCELLED', async () => {
      const activeChallan = {
        id: 'dc-102',
        ewbNumber: '321098765432',
        ewbStatus: 'GENERATED',
      };

      mockPrisma.deliveryChallan.findUnique.mockResolvedValue(activeChallan);
      mockPrisma.deliveryChallan.update.mockImplementation(({ data }) =>
        Promise.resolve({ ...activeChallan, ...data }),
      );

      const res = await TaxproService.cancelDeliveryChallanEwb('dc-102', '1', 'Order cancelled');

      expect(res.success).toBe(true);
      expect(res.cancelledDate).toBeInstanceOf(Date);
      expect(mockPrisma.deliveryChallan.update).toHaveBeenCalledWith({
        where: { id: 'dc-102' },
        data: expect.objectContaining({
          ewbStatus: 'CANCELLED',
        }),
      });
    });
  });

  describe('4. Inward Purchase E-Way Bill (URP)', () => {
    it('generates Inward Purchase EWB for raw material arrivals from unregistered suppliers', async () => {
      const mockStockIn = {
        id: 'si-201',
        invoiceNumber: 'FARM-BILL-09',
        arrivalDate: new Date('2026-09-09'),
        lorryNumber: 'KA01AB9876',
        rvpKataKg: 15000,
        billingWeightKg: 15000,
        billingRatePerKg: 12,
        ewbNumber: null,
        ewbStatus: null,
        ewbDistance: 120,
        purchaseOrder: {
          pricePerKg: 12,
          party: {
            name: 'LOCAL FARMER SUPPLIER',
            gstin: null, // Unregistered Person (URP)
            address: 'Palamaner Rural Fields',
            city: 'Palamaner',
            pincode: '517247',
          },
        },
      };

      mockPrisma.stockIn.findUnique.mockResolvedValue(mockStockIn);
      mockPrisma.stockIn.update.mockImplementation(({ data }) =>
        Promise.resolve({ ...mockStockIn, ...data }),
      );

      const res = await TaxproService.generateInwardPurchaseEwb('si-201', {
        vehicleNumber: 'KA01AB9876',
        transDistance: 120,
      });

      expect(res.success).toBe(true);
      expect(res.ewbNumber).toBeDefined();
      expect(res.distance).toBe(120);
      expect(mockPrisma.stockIn.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'si-201' },
          data: expect.objectContaining({
            ewbStatus: 'GENERATED',
            ewbDistance: 120,
          }),
        }),
      );
    });

    it('cancels Inward Purchase EWB and marks status as CANCELLED', async () => {
      const activeStockIn = {
        id: 'si-202',
        ewbNumber: '412345678901',
        ewbStatus: 'GENERATED',
      };

      mockPrisma.stockIn.findUnique.mockResolvedValue(activeStockIn);
      mockPrisma.stockIn.update.mockImplementation(({ data }) =>
        Promise.resolve({ ...activeStockIn, ...data }),
      );

      const res = await TaxproService.cancelStockInEwb('si-202', '2', 'Wrong vehicle entered');

      expect(res.success).toBe(true);
      expect(mockPrisma.stockIn.update).toHaveBeenCalledWith({
        where: { id: 'si-202' },
        data: expect.objectContaining({
          ewbStatus: 'CANCELLED',
        }),
      });
    });
  });

  describe('5. Consolidated E-Way Bill (CEWB)', () => {
    it('bundles multiple active EWBs into a single CEWB record', async () => {
      mockPrisma.consolidatedEwb.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'cewb-301', ...data }),
      );

      const res = await TaxproService.generateConsolidatedEwb({
        vehicleNo: 'AP04TU9999',
        fromPlace: 'Punganur',
        fromState: 37,
        ewbNumbers: ['123456789012', '987654321098'],
        remarks: 'Single lorry consolidating 2 factory deliveries',
      });

      expect(res.success).toBe(true);
      expect(res.cEwbNumber).toBeDefined();
      expect(mockPrisma.consolidatedEwb.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            vehicleNumber: 'AP04TU9999',
            fromPlace: 'Punganur',
            fromState: 37,
            ewbNumbers: ['123456789012', '987654321098'],
          }),
        }),
      );
    });

    it('throws validation error if no EWB numbers provided', async () => {
      await expect(
        TaxproService.generateConsolidatedEwb({
          vehicleNo: 'AP04TU9999',
          fromPlace: 'Punganur',
          fromState: 37,
          ewbNumbers: [],
        }),
      ).rejects.toThrow(/At least one E-Way Bill number is required/i);
    });
  });
});
