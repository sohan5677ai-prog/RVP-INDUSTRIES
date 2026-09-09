import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPrisma = {
  gstr2bImport: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    findMany: vi.fn(),
  },
  gstr2bEntry: {
    findMany: vi.fn(),
    createMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  stockIn: {
    findMany: vi.fn(),
  },
  party: {
    findMany: vi.fn(),
  },
};

const mockCompany = {
  name: 'RVP INDUSTRIES PRIVATE LIMITED',
  gstin: '37AABCR1234F1Z5',
  taxproGspId: null, // mock mode (0 credit consumption)
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

const { Gstr2bReconciliationService } = await import('./gstr2bReconciliation.service.js');
const { TaxproService } = await import('./taxpro.service.js');

describe('GSTR-2B Purchase ITC Automated Reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('1. Normalization & Helpers', () => {
    it('normalizes invoice numbers by stripping slashes, dashes, spaces and leading zeros', () => {
      expect(Gstr2bReconciliationService.normalizeInvoiceNumber('INV/2026/0045')).toBe('INV202645');
      expect(Gstr2bReconciliationService.normalizeInvoiceNumber('  00069  ')).toBe('69');
      expect(Gstr2bReconciliationService.normalizeInvoiceNumber('RVP-B2B-01')).toBe('RVPB2B1');
    });

    it('normalizes GSTIN to uppercase alphanumeric', () => {
      expect(Gstr2bReconciliationService.normalizeGstin(' 33aabcb9999g1z8 ')).toBe('33AABCB9999G1Z8');
    });

    it('correctly calculates financial year and date range from MMYYYY return period', () => {
      const { start, end, fy, month, year } = Gstr2bReconciliationService.periodToDateRange('082026');
      expect(month).toBe(8);
      expect(year).toBe(2026);
      expect(fy).toBe('2026-27');
      expect(start.getUTCFullYear()).toBe(2026);
      expect(start.getUTCMonth()).toBe(7); // August (0-indexed)
      expect(end.getUTCDate()).toBe(31);
    });
  });

  describe('2. Official GSTR-2B JSON Parsing', () => {
    it('parses standard B2B, B2BA, and CDNR sections from official GST portal JSON', () => {
      const samplePortalJson = {
        data: {
          gstin: '37AABCR1234F1Z5',
          fp: '082026',
          docdata: {
            b2b: [
              {
                ctin: '33AABCB9999G1Z8',
                trdnm: 'PACKAGING CORPN',
                inv: [
                  {
                    inum: 'INV-08-101',
                    idt: '15-08-2026',
                    val: 105000,
                    itcavl: 'Y',
                    items: [
                      {
                        num: 1,
                        txval: 100000,
                        rt: 5.0,
                        igst: 5000,
                        cgst: 0,
                        sgst: 0,
                        cess: 0,
                      },
                    ],
                  },
                ],
              },
            ],
            cdnr: [
              {
                ctin: '33AABCB9999G1Z8',
                trdnm: 'PACKAGING CORPN',
                nt: [
                  {
                    ntnum: 'CN-08-01',
                    ntdt: '20-08-2026',
                    nt_typ: 'C',
                    val: 5250,
                    items: [
                      {
                        num: 1,
                        txval: 5000,
                        igst: 250,
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      };

      const { period, entries } = Gstr2bReconciliationService.parseGstr2bJson(samplePortalJson);
      expect(period).toBe('082026');
      expect(entries).toHaveLength(2);

      const inv = entries.find((e) => e.docType === 'INV');
      expect(inv).toBeDefined();
      expect(inv?.supplierGstin).toBe('33AABCB9999G1Z8');
      expect(inv?.invoiceNumber).toBe('INV-08-101');
      expect(inv?.taxableValue).toBe(100000);
      expect(inv?.igst).toBe(5000);
      expect(inv?.totalAmount).toBe(105000);

      const cn = entries.find((e) => e.docType === 'CRN');
      expect(cn).toBeDefined();
      expect(cn?.invoiceNumber).toBe('CN-08-01');
      expect(cn?.taxableValue).toBe(5000);
    });
  });

  describe('3. 4-Way Reconciliation Matching Engine', () => {
    it('accurately categorizes Matched, Missing in 2B, and Missing in Books', async () => {
      // 1. GSTR-2B Portal entries
      const mockPortalEntries = [
        {
          id: 'p-1',
          supplierGstin: '33AABCB9999G1Z8',
          supplierName: 'TAMIL BAGS LTD',
          docType: 'INV',
          invoiceNumber: 'TB/26-27/045',
          invoiceDate: new Date('2026-08-10'),
          taxableValue: 100000,
          igst: 5000,
          cgst: 0,
          sgst: 0,
          cess: 0,
          totalAmount: 105000,
          itcAvailable: true,
          filingDate: new Date('2026-08-11'),
          sourceSection: 'B2B',
        },
        {
          id: 'p-2',
          supplierGstin: '37XYZAB1111H1Z2',
          supplierName: 'LOCAL OIL MILL',
          docType: 'INV',
          invoiceNumber: 'OM-999', // Missing in ERP Books!
          invoiceDate: new Date('2026-08-14'),
          taxableValue: 50000,
          igst: 0,
          cgst: 1250,
          sgst: 1250,
          cess: 0,
          totalAmount: 52500,
          itcAvailable: true,
          filingDate: new Date('2026-08-12'),
          sourceSection: 'B2B',
        },
      ];

      // 2. ERP Books purchases (StockIn)
      const mockStockIns = [
        {
          id: 'si-1',
          invoiceNumber: 'TB/26-27/0045', // Matches TB/26-27/045 via normalization!
          arrivalDate: new Date('2026-08-10'),
          billingWeightKg: 10000,
          billingRatePerKg: 10, // 10000 * 10 = 100,000 taxable
          purchaseOrder: {
            hasGst: true,
            pricePerKg: 10,
            party: {
              name: 'TAMIL BAGS LTD',
              gstin: '33AABCB9999G1Z8',
              phone: '9876543210',
            },
          },
        },
        {
          id: 'si-2',
          invoiceNumber: 'DELINQUENT-001', // Supplier failed to file GSTR-1! (Missing in 2B)
          arrivalDate: new Date('2026-08-22'),
          billingWeightKg: 20000,
          billingRatePerKg: 10, // 20000 * 10 = 200,000 taxable, GST 10,000
          purchaseOrder: {
            hasGst: true,
            pricePerKg: 10,
            party: {
              name: 'DELINQUENT SUPPLIER',
              gstin: '29ABCDE1234F1Z5',
              phone: '9123456780',
            },
          },
        },
      ];

      mockPrisma.gstr2bEntry.findMany.mockResolvedValue(mockPortalEntries);
      mockPrisma.stockIn.findMany.mockResolvedValue(mockStockIns);

      const summary = await Gstr2bReconciliationService.reconcile('082026');

      expect(summary.period).toBe('082026');
      expect(summary.financialYear).toBe('2026-27');
      expect(summary.counts.total).toBe(3);

      // Verify Matched row
      const matchedRow = summary.rows.find((r) => r.status === 'MATCHED');
      expect(matchedRow).toBeDefined();
      expect(matchedRow?.supplierGstin).toBe('33AABCB9999G1Z8');
      expect(matchedRow?.booksTaxable).toBe(100000);
      expect(matchedRow?.booksItc).toBe(5000);

      // Verify Missing in 2B row (Delinquent)
      const missing2bRow = summary.rows.find((r) => r.status === 'MISSING_IN_2B');
      expect(missing2bRow).toBeDefined();
      expect(missing2bRow?.supplierGstin).toBe('29ABCDE1234F1Z5');
      expect(missing2bRow?.booksItc).toBe(10000);

      // Verify Missing in Books row (Unclaimed credit)
      const missingBooksRow = summary.rows.find((r) => r.status === 'MISSING_IN_BOOKS');
      expect(missingBooksRow).toBeDefined();
      expect(missingBooksRow?.invoiceNumber).toBe('OM-999');
      expect(missingBooksRow?.portalItc).toBe(2500);

      // Verify KPI sums
      expect(summary.matchedItc).toBe(5000);
      expect(summary.missingIn2bItc).toBe(10000); // At-Risk ITC
      expect(summary.missingInBooksItc).toBe(2500); // Discovered unclaimed ITC
    });
  });

  describe('4. Delinquent Supplier Legal WhatsApp Reminder', () => {
    it('builds clear legal reminder with invoice details for non-filing suppliers', () => {
      const row = {
        id: 'r-1',
        status: 'MISSING_IN_2B' as const,
        statusLabel: 'Missing in GSTR-2B',
        supplierGstin: '29ABCDE1234F1Z5',
        supplierName: 'KARNATAKA SPARES PVT LTD',
        supplierPhone: '9876543210',
        docType: 'INV',
        invoiceNumber: 'KS/08/112',
        invoiceDate: '2026-08-15T00:00:00.000Z',
        booksTaxable: 200000,
        booksItc: 10000,
        booksTotal: 210000,
      };

      const msg = Gstr2bReconciliationService.buildWhatsAppReminder(row);
      expect(msg).toContain('KARNATAKA SPARES PVT LTD');
      expect(msg).toContain('KS/08/112');
      expect(msg).toContain('29ABCDE1234F1Z5');
      expect(msg).toContain('CGST Rule 36(4)');
      expect(msg).toContain('RVP Industries');
    });
  });

  describe('5. TaxPro GSP Returns API Sandbox Safety', () => {
    it('executes in mock/sandbox mode with ZERO real credit consumption', async () => {
      mockPrisma.party.findMany.mockResolvedValue([
        { gstin: '37AABCR1234F1Z5', name: 'TEST SEED SUPPLIER' },
      ]);

      const res = await TaxproService.fetchGstr2b('082026');
      expect(res.success).toBe(true);
      expect(res.period).toBe('082026');
      expect(res.data.docdata.b2b.length).toBeGreaterThan(0);
      expect(res.message).toContain('0 credits consumed');
    });

    it('connects to live production TaxPro & NIC registry when credentials exist', async () => {
      // Mock live credentials
      vi.spyOn(TaxproService as any, 'credsMissing').mockReturnValue(false);
      vi.spyOn(TaxproService as any, 'withAuth').mockImplementation(async (...args: any[]) => {
        return args[2]('fake-auth-token');
      });
      vi.spyOn(TaxproService as any, 'request').mockResolvedValue({
        status: '1',
        data: [
          {
            genGstin: '37AAAPL1234F1Z1',
            fromTrdName: 'LIVE AGRO SUPPLIER',
            docNo: 'INV-2026-99',
            docDate: '15/08/2026',
            totalValue: 50000,
            cgstValue: 1250,
            sgstValue: 1250,
            igstValue: 0,
            cessValue: 0,
            totInvValue: 52500,
          },
        ],
      });

      mockCompany.taxproSandbox = false;
      const res = await TaxproService.fetchGstr2b('082026', 'live');
      mockCompany.taxproSandbox = true;
      expect(res.success).toBe(true);
      expect(res.period).toBe('082026');
      expect(res.data.docdata.b2b.length).toBeGreaterThan(0);
      expect(res.data.docdata.b2b[0].ctin).toBe('37AAAPL1234F1Z1');
      expect(res.data.docdata.b2b[0].inv[0].inum).toBe('INV-2026-99');
      expect(res.message).toContain('Live TaxPro sync complete');
    });
  });
});
