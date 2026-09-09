import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPrisma = {
  creditNote: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  debitNote: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  productTaxInfo: {
    findUnique: vi.fn(),
  },
};

const mockCompany = {
  name: 'RVP INDUSTRIES PRIVATE LIMITED',
  gstin: '37AABCR1234F1Z5',
  address: 'Industrial Estate',
  pincode: '517247',
  stateName: 'Andhra Pradesh',
  taxproGspId: null, // mock mode
  taxproGspSecret: null,
  taxproGstUser: null,
  taxproGstPass: null,
  taxproSandbox: false,
};

vi.mock('../lib/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../controllers/settings.controller.js', () => ({
  getCompanyProfileRow: vi.fn(() => Promise.resolve(mockCompany)),
}));
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { TaxproService } = await import('./taxpro.service.js');

describe('TaxPro E-Credit Note & E-Debit Note IRN', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('correctly prepares e-Invoice payload with Typ "CRN" for Credit Notes', async () => {
    const mockNote = {
      id: 'cn-1',
      noteNumber: 'RVP/CN/01/26-27',
      noteDate: new Date('2026-09-09T00:00:00.000Z'),
      reason: 'Quality discount',
      taxableValue: '10000.00',
      gstRate: '5.00',
      gstAmount: '500.00',
      totalAmount: '10500.00',
      party: {
        name: 'BUYER ENTERPRISES',
        gstin: '33AABCB9999G1Z8', // Tamil Nadu (Inter-state: 37 -> 33)
        address: '123 Market Road',
        city: 'Salem',
        state: 'Tamil Nadu',
        pincode: '636001',
      },
      saleDispatch: null,
    };

    mockPrisma.creditNote.findUnique.mockResolvedValue(mockNote);

    const payload = await TaxproService.prepareNoteEInvoicePayload('cn-1', 'CREDIT');

    expect(payload.DocDtls.Typ).toBe('CRN');
    expect(payload.DocDtls.No).toBe('RVP/CN/01/26-27');
    expect(payload.SellerDtls.Gstin).toBe('37AABCR1234F1Z5');
    expect(payload.BuyerDtls.Gstin).toBe('33AABCB9999G1Z8');
    expect(payload.ValDtls.AssVal).toBe(10000);
    expect(payload.ValDtls.IgstVal).toBe(500);
    expect(payload.ValDtls.CgstVal).toBe(0);
    expect(payload.ValDtls.SgstVal).toBe(0);
    expect(payload.ValDtls.TotInvVal).toBe(10500);
    expect(payload.ItemList[0].HsnCd.length).toBeGreaterThanOrEqual(6);
  });

  it('correctly prepares e-Invoice payload with Typ "DBN" and intra-state CGST/SGST for Debit Notes', async () => {
    const mockNote = {
      id: 'dn-1',
      noteNumber: 'RVP/DN/01/26-27',
      noteDate: new Date('2026-09-09T00:00:00.000Z'),
      reason: 'Rate adjustment',
      taxableValue: '20000.00',
      gstRate: '5.00',
      gstAmount: '1000.00',
      totalAmount: '21000.00',
      party: {
        name: 'ANDHRA TRADERS',
        gstin: '37XYZAB1111H1Z2', // Andhra Pradesh (Intra-state: 37 -> 37)
        address: 'Main Road',
        city: 'Tirupati',
        state: 'Andhra Pradesh',
        pincode: '517501',
      },
      saleDispatch: null,
    };

    mockPrisma.debitNote.findUnique.mockResolvedValue(mockNote);

    const payload = await TaxproService.prepareNoteEInvoicePayload('dn-1', 'DEBIT');

    expect(payload.DocDtls.Typ).toBe('DBN');
    expect(payload.DocDtls.No).toBe('RVP/DN/01/26-27');
    expect(payload.SellerDtls.Gstin).toBe('37AABCR1234F1Z5');
    expect(payload.BuyerDtls.Gstin).toBe('37XYZAB1111H1Z2');
    expect(payload.ValDtls.AssVal).toBe(20000);
    expect(payload.ValDtls.IgstVal).toBe(0);
    expect(payload.ValDtls.CgstVal).toBe(500);
    expect(payload.ValDtls.SgstVal).toBe(500);
    expect(payload.ValDtls.TotInvVal).toBe(21000);
  });

  it('throws an error if party has no GSTIN', async () => {
    const mockNote = {
      id: 'cn-2',
      noteNumber: 'RVP/CN/02/26-27',
      noteDate: new Date(),
      reason: 'Cash adjustment',
      taxableValue: '5000',
      gstRate: '5',
      party: {
        name: 'UNREGISTERED TRADER',
        gstin: null,
      },
    };

    mockPrisma.creditNote.findUnique.mockResolvedValue(mockNote);

    await expect(TaxproService.prepareNoteEInvoicePayload('cn-2', 'CREDIT')).rejects.toThrow(
      /requires a registered B2B GSTIN/i
    );
  });

  it('generates simulated IRN and signed QR code when credentials are not configured', async () => {
    const mockNote = {
      id: 'cn-3',
      noteNumber: 'RVP/CN/03/26-27',
      noteDate: new Date('2026-09-09T00:00:00.000Z'),
      reason: 'Shortage credit',
      taxableValue: '8000',
      gstRate: '5',
      party: {
        name: 'TAMIL BUYER',
        gstin: '33AABCB9999G1Z8',
      },
    };

    mockPrisma.creditNote.findUnique.mockResolvedValue(mockNote);

    const result = await TaxproService.generateNoteIRN('cn-3', 'CREDIT');

    expect(result.success).toBe(true);
    expect(result.irn).toHaveLength(64);
    expect(result.ackNo).toBeDefined();
    expect(result.signedQr).toContain('IRN:');
    expect(result.signedQr).toContain('DocType:CRN');
    expect(result.signedQr).toContain('DocNo:RVP/CN/03/26-27');
  });
});
