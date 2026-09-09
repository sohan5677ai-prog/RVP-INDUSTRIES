import { prisma } from '../lib/prisma.js';
import { purchaseGst, PURCHASE_GST_PCT } from '../lib/calc.js';
import { TaxproService } from './taxpro.service.js';

export interface ParsedGstr2bEntry {
  supplierGstin: string;
  supplierName: string;
  docType: 'INV' | 'CRN' | 'DBN';
  invoiceNumber: string;
  invoiceDate: Date;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  totalAmount: number;
  itcAvailable: boolean;
  filingDate?: Date | null;
  sourceSection: 'B2B' | 'B2BA' | 'CDNR' | 'CDNRA';
}

export interface ReconciliationSummary {
  period: string;
  financialYear: string;
  totalGstr2bItc: number;
  totalGstr2bTaxable: number;
  totalBooksItc: number;
  totalBooksTaxable: number;
  matchedItc: number;
  matchedTaxable: number;
  missingIn2bItc: number;
  missingIn2bTaxable: number;
  missingInBooksItc: number;
  missingInBooksTaxable: number;
  discrepancyItc: number;
  discrepancyCount: number;
  counts: {
    matched: number;
    missingIn2b: number;
    missingInBooks: number;
    mismatch: number;
    total: number;
  };
  rows: ReconciliationRow[];
}

export interface ReconciliationRow {
  id: string;
  status: 'MATCHED' | 'MISSING_IN_2B' | 'MISSING_IN_BOOKS' | 'MISMATCH_VALUE' | 'MISMATCH_TAX';
  statusLabel: string;
  supplierGstin: string;
  supplierName: string;
  supplierPhone?: string | null;
  docType: string;
  invoiceNumber: string;
  invoiceDate: string;
  // Books (ERP)
  booksTaxable?: number | null;
  booksItc?: number | null;
  booksTotal?: number | null;
  stockInId?: string | null;
  // GSTR-2B (Portal)
  portalTaxable?: number | null;
  portalItc?: number | null;
  portalTotal?: number | null;
  diffTaxable?: number | null;
  diffItc?: number | null;
  itcAvailable?: boolean;
  filingDate?: string | null;
  sourceSection?: string | null;
}

export class Gstr2bReconciliationService {
  /**
   * Normalizes an invoice number for fuzzy/strict cross-matching:
   * Splits on non-alphanumeric separators, strips leading zeros from numeric tokens, and joins.
   * e.g. "INV/2026/0045" -> "INV202645", "TB/26-27/045" -> "TB262745", "0069" -> "69"
   */
  public static normalizeInvoiceNumber(inv: string): string {
    if (!inv) return '';
    const upper = String(inv).toUpperCase().trim();
    // Split into segments
    const parts = upper.split(/[^A-Z0-9]+/).filter(Boolean);
    if (parts.length === 0) return '';

    return parts
      .map((p) => (/^\d+$/.test(p) ? p.replace(/^0+/, '') || '0' : p))
      .join('');
  }

  /**
   * Normalizes a GSTIN to 15 uppercase alphanumeric characters.
   */
  public static normalizeGstin(gstin: string): string {
    if (!gstin) return '';
    return String(gstin).toUpperCase().trim().replace(/[^A-Z0-9]/g, '');
  }

  /**
   * Parses various Indian date string formats (DD-MM-YYYY, YYYY-MM-DD, DD/MM/YYYY).
   */
  public static parseGstDate(rawDate: string | Date | undefined): Date {
    if (!rawDate) return new Date();
    if (rawDate instanceof Date) return rawDate;
    const str = String(rawDate).trim();
    if (/^\d{2}-\d{2}-\d{4}$/.test(str)) {
      const [d, m, y] = str.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, d));
    }
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(str)) {
      const [d, m, y] = str.split('/').map(Number);
      return new Date(Date.UTC(y, m - 1, d));
    }
    const parsed = new Date(str);
    return isNaN(parsed.getTime()) ? new Date() : parsed;
  }

  /**
   * Derives start and end Date for a given MMYYYY return period (e.g. 082026).
   */
  public static periodToDateRange(period: string): { start: Date; end: Date; fy: string; month: number; year: number } {
    const clean = period.replace(/[^0-9]/g, '');
    if (clean.length !== 6) {
      throw new Error('Invalid return period format. Expected MMYYYY (e.g. 082026)');
    }
    const month = parseInt(clean.slice(0, 2), 10);
    const year = parseInt(clean.slice(2), 10);

    const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
    const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

    const fyYear = month >= 4 ? year : year - 1;
    const nextYearShort = String((fyYear + 1) % 100).padStart(2, '0');
    const fy = `${fyYear}-${nextYearShort}`;

    return { start, end, fy, month, year };
  }

  /**
   * Parses official GSTR-2B JSON payloads (direct portal export or GSP payload).
   */
  public static parseGstr2bJson(payload: any): { period: string; entries: ParsedGstr2bEntry[] } {
    const raw = payload?.data ?? payload?.Data ?? payload;
    const fp = String(raw?.fp || raw?.return_period || raw?.period || '').replace(/[^0-9]/g, '');
    const docdata = raw?.docdata || raw;

    const entries: ParsedGstr2bEntry[] = [];

    // 1. Process B2B Invoices
    const b2bList = Array.isArray(docdata?.b2b) ? docdata.b2b : [];
    for (const supplier of b2bList) {
      const ctin = this.normalizeGstin(supplier.ctin || '');
      const trdnm = String(supplier.trdnm || supplier.tradeName || ctin).trim();
      const invList = Array.isArray(supplier.inv) ? supplier.inv : [];

      for (const inv of invList) {
        const inum = String(inv.inum || inv.inv_num || '').trim();
        const idt = this.parseGstDate(inv.idt || inv.inv_date);
        const filingDate = inv.dt ? this.parseGstDate(inv.dt) : null;
        const itcAvailable = inv.itcavl !== 'N';

        let taxableValue = 0;
        let igst = 0;
        let cgst = 0;
        let sgst = 0;
        let cess = 0;

        if (Array.isArray(inv.items) && inv.items.length > 0) {
          for (const itm of inv.items) {
            taxableValue += Number(itm.txval || 0);
            igst += Number(itm.igst || 0);
            cgst += Number(itm.cgst || 0);
            sgst += Number(itm.sgst || 0);
            cess += Number(itm.cess || 0);
          }
        } else {
          taxableValue = Number(inv.val || 0);
          igst = Number(inv.igst || 0);
          cgst = Number(inv.cgst || 0);
          sgst = Number(inv.sgst || 0);
        }

        const totalAmount = Number(inv.val) || Math.round((taxableValue + igst + cgst + sgst + cess) * 100) / 100;

        if (inum && ctin) {
          entries.push({
            supplierGstin: ctin,
            supplierName: trdnm,
            docType: 'INV',
            invoiceNumber: inum,
            invoiceDate: idt,
            taxableValue: Math.round(taxableValue * 100) / 100,
            igst: Math.round(igst * 100) / 100,
            cgst: Math.round(cgst * 100) / 100,
            sgst: Math.round(sgst * 100) / 100,
            cess: Math.round(cess * 100) / 100,
            totalAmount,
            itcAvailable,
            filingDate,
            sourceSection: 'B2B',
          });
        }
      }
    }

    // 2. Process B2BA (Amendments)
    const b2baList = Array.isArray(docdata?.b2ba) ? docdata.b2ba : [];
    for (const supplier of b2baList) {
      const ctin = this.normalizeGstin(supplier.ctin || '');
      const trdnm = String(supplier.trdnm || supplier.tradeName || ctin).trim();
      const invList = Array.isArray(supplier.inv) ? supplier.inv : [];

      for (const inv of invList) {
        const inum = String(inv.inum || '').trim();
        const idt = this.parseGstDate(inv.idt);
        let taxableValue = 0;
        let igst = 0;
        let cgst = 0;
        let sgst = 0;
        let cess = 0;

        if (Array.isArray(inv.items)) {
          for (const itm of inv.items) {
            taxableValue += Number(itm.txval || 0);
            igst += Number(itm.igst || 0);
            cgst += Number(itm.cgst || 0);
            sgst += Number(itm.sgst || 0);
            cess += Number(itm.cess || 0);
          }
        }
        const totalAmount = Number(inv.val) || Math.round((taxableValue + igst + cgst + sgst + cess) * 100) / 100;
        if (inum && ctin) {
          entries.push({
            supplierGstin: ctin,
            supplierName: trdnm,
            docType: 'INV',
            invoiceNumber: inum,
            invoiceDate: idt,
            taxableValue: Math.round(taxableValue * 100) / 100,
            igst: Math.round(igst * 100) / 100,
            cgst: Math.round(cgst * 100) / 100,
            sgst: Math.round(sgst * 100) / 100,
            cess: Math.round(cess * 100) / 100,
            totalAmount,
            itcAvailable: inv.itcavl !== 'N',
            filingDate: inv.dt ? this.parseGstDate(inv.dt) : null,
            sourceSection: 'B2BA',
          });
        }
      }
    }

    // 3. Process CDNR (Credit / Debit Notes from Suppliers)
    const cdnrList = Array.isArray(docdata?.cdnr) ? docdata.cdnr : [];
    for (const supplier of cdnrList) {
      const ctin = this.normalizeGstin(supplier.ctin || '');
      const trdnm = String(supplier.trdnm || supplier.tradeName || ctin).trim();
      const ntList = Array.isArray(supplier.nt) ? supplier.nt : [];

      for (const nt of ntList) {
        const ntnum = String(nt.ntnum || nt.nt_num || '').trim();
        const ntdt = this.parseGstDate(nt.ntdt || nt.nt_dt);
        const docType = nt.nt_typ === 'C' ? 'CRN' : 'DBN';

        let taxableValue = 0;
        let igst = 0;
        let cgst = 0;
        let sgst = 0;
        let cess = 0;

        if (Array.isArray(nt.items)) {
          for (const itm of nt.items) {
            taxableValue += Number(itm.txval || 0);
            igst += Number(itm.igst || 0);
            cgst += Number(itm.cgst || 0);
            sgst += Number(itm.sgst || 0);
            cess += Number(itm.cess || 0);
          }
        }
        const totalAmount = Number(nt.val) || Math.round((taxableValue + igst + cgst + sgst + cess) * 100) / 100;
        if (ntnum && ctin) {
          entries.push({
            supplierGstin: ctin,
            supplierName: trdnm,
            docType,
            invoiceNumber: ntnum,
            invoiceDate: ntdt,
            taxableValue: Math.round(taxableValue * 100) / 100,
            igst: Math.round(igst * 100) / 100,
            cgst: Math.round(cgst * 100) / 100,
            sgst: Math.round(sgst * 100) / 100,
            cess: Math.round(cess * 100) / 100,
            totalAmount,
            itcAvailable: nt.itcavl !== 'N',
            filingDate: nt.dt ? this.parseGstDate(nt.dt) : null,
            sourceSection: 'CDNR',
          });
        }
      }
    }

    return { period: fp, entries };
  }

  /**
   * Ingests parsed GSTR-2B entries into the database.
   */
  public static async saveGstr2bImport(
    period: string,
    source: 'TAXPRO_API' | 'JSON_UPLOAD',
    entries: ParsedGstr2bEntry[],
  ) {
    const { fy, month, year } = this.periodToDateRange(period);

    const totalInvoices = entries.length;
    const totalTaxable = entries.reduce((acc, e) => acc + (e.docType === 'CRN' ? -e.taxableValue : e.taxableValue), 0);
    const totalItc = entries.reduce((acc, e) => {
      const tax = e.igst + e.cgst + e.sgst;
      return acc + (e.docType === 'CRN' ? -tax : tax);
    }, 0);

    // Upsert Gstr2bImport
    const existing = await prisma.gstr2bImport.findUnique({
      where: {
        financialPeriod_importSource: {
          financialPeriod: period,
          importSource: source,
        },
      },
    });

    let importId: string;
    if (existing) {
      importId = existing.id;
      // Delete old entries and re-insert
      await prisma.gstr2bEntry.deleteMany({ where: { importId } });
      await prisma.gstr2bImport.update({
        where: { id: importId },
        data: {
          uploadedAt: new Date(),
          totalInvoices,
          totalTaxable: Math.round(totalTaxable * 100) / 100,
          totalItc: Math.round(totalItc * 100) / 100,
        },
      });
    } else {
      const created = await prisma.gstr2bImport.create({
        data: {
          financialPeriod: period,
          financialYear: fy,
          month,
          year,
          importSource: source,
          totalInvoices,
          totalTaxable: Math.round(totalTaxable * 100) / 100,
          totalItc: Math.round(totalItc * 100) / 100,
        },
      });
      importId = created.id;
    }

    // Insert entries in chunks
    if (entries.length > 0) {
      await prisma.gstr2bEntry.createMany({
        data: entries.map((e) => ({
          importId,
          supplierGstin: e.supplierGstin,
          supplierName: e.supplierName,
          docType: e.docType,
          invoiceNumber: e.invoiceNumber,
          invoiceDate: e.invoiceDate,
          taxableValue: e.taxableValue,
          igst: e.igst,
          cgst: e.cgst,
          sgst: e.sgst,
          cess: e.cess,
          totalAmount: e.totalAmount,
          itcAvailable: e.itcAvailable,
          filingDate: e.filingDate,
          sourceSection: e.sourceSection,
        })),
      });
    }

    return {
      importId,
      period,
      totalInvoices,
      totalTaxable,
      totalItc,
    };
  }

  /**
   * Syncs official GSTR-2B via TaxPro GSP (using sandbox/mock safety).
   */
  public static async syncFromTaxPro(period: string, mode: 'live' | 'sandbox' = 'sandbox') {
    const res = await TaxproService.fetchGstr2b(period, mode);
    const parsed = this.parseGstr2bJson(res.data);
    const effectivePeriod = parsed.period || period;
    const saveResult = await this.saveGstr2bImport(effectivePeriod, 'TAXPRO_API', parsed.entries);
    return {
      ...saveResult,
      message: res.message || 'Synced GSTR-2B successfully via TaxPro GSP',
    };
  }

  /**
   * Reconciles ERP Books purchases against GSTR-2B statement for the requested MMYYYY period.
   */
  public static async reconcile(period: string): Promise<ReconciliationSummary> {
    const { start, end, fy } = this.periodToDateRange(period);

    // 1. Fetch imported GSTR-2B entries for this period
    // Prefer TAXPRO_API if exists, otherwise JSON_UPLOAD, or combine
    const gstr2bEntries = await prisma.gstr2bEntry.findMany({
      where: {
        import: {
          financialPeriod: period,
        },
      },
      include: {
        import: true,
      },
    });

    // 2. Fetch ERP Books Purchases (StockIn with hasGst: true)
    const stockIns = await prisma.stockIn.findMany({
      where: {
        arrivalDate: { gte: start, lte: end },
        purchaseOrder: { hasGst: true },
      },
      include: {
        purchaseOrder: {
          include: {
            party: true,
          },
        },
      },
      orderBy: { arrivalDate: 'asc' },
    });

    // Build ERP books purchase map
    interface ErpPurchaseItem {
      stockInId: string;
      invoiceNumber: string;
      normInv: string;
      invoiceDate: Date;
      supplierGstin: string;
      normGstin: string;
      supplierName: string;
      supplierPhone?: string | null;
      taxableValue: number;
      itcAmount: number;
      totalAmount: number;
      matched?: boolean;
    }

    const erpItems: ErpPurchaseItem[] = stockIns.map((s) => {
      const { ratePerKg, taxableValue, amount: gst } = purchaseGst({
        hasGst: true,
        billingWeightKg: s.billingWeightKg,
        pricePerKg: s.purchaseOrder.pricePerKg,
        billingRatePerKg: s.billingRatePerKg,
      });

      const party = s.purchaseOrder.party;
      const gstin = party.gstin || '';
      const totalAmount = Math.round((taxableValue + gst) * 100) / 100;

      return {
        stockInId: s.id,
        invoiceNumber: s.invoiceNumber,
        normInv: this.normalizeInvoiceNumber(s.invoiceNumber),
        invoiceDate: s.arrivalDate,
        supplierGstin: gstin,
        normGstin: this.normalizeGstin(gstin),
        supplierName: party.name,
        supplierPhone: party.phone,
        taxableValue,
        itcAmount: gst,
        totalAmount,
      };
    });

    const reconciliationRows: ReconciliationRow[] = [];
    const TOLERANCE = 2.0; // ₹2 rounding threshold

    // Keep track of matched portal entries
    const matchedPortalIds = new Set<string>();

    // 3. For every ERP purchase, look for a matching entry in GSTR-2B
    for (const erp of erpItems) {
      // Look for portal entry matching: normalized GSTIN & normalized invoice number
      const match = gstr2bEntries.find(
        (p) =>
          !matchedPortalIds.has(p.id) &&
          this.normalizeGstin(p.supplierGstin) === erp.normGstin &&
          this.normalizeInvoiceNumber(p.invoiceNumber) === erp.normInv,
      );

      if (match) {
        matchedPortalIds.add(match.id);
        const portalTaxable = Number(match.taxableValue);
        const portalItc = Number(match.igst) + Number(match.cgst) + Number(match.sgst);
        const portalTotal = Number(match.totalAmount);

        const diffTaxable = Math.round((erp.taxableValue - portalTaxable) * 100) / 100;
        const diffItc = Math.round((erp.itcAmount - portalItc) * 100) / 100;

        let status: ReconciliationRow['status'] = 'MATCHED';
        let statusLabel = 'Fully Matched (Safe ITC)';

        if (Math.abs(diffTaxable) > TOLERANCE) {
          status = 'MISMATCH_VALUE';
          statusLabel = 'Taxable Value Mismatch';
        } else if (Math.abs(diffItc) > TOLERANCE) {
          status = 'MISMATCH_TAX';
          statusLabel = 'Tax Amount Mismatch';
        }

        reconciliationRows.push({
          id: `match-${erp.stockInId}-${match.id}`,
          status,
          statusLabel,
          supplierGstin: erp.supplierGstin,
          supplierName: erp.supplierName,
          supplierPhone: erp.supplierPhone,
          docType: match.docType,
          invoiceNumber: erp.invoiceNumber,
          invoiceDate: erp.invoiceDate.toISOString(),
          booksTaxable: erp.taxableValue,
          booksItc: erp.itcAmount,
          booksTotal: erp.totalAmount,
          stockInId: erp.stockInId,
          portalTaxable,
          portalItc,
          portalTotal,
          diffTaxable,
          diffItc,
          itcAvailable: match.itcAvailable,
          filingDate: match.filingDate ? match.filingDate.toISOString() : null,
          sourceSection: match.sourceSection,
        });
      } else {
        // Missing in GSTR-2B -> Supplier has not uploaded (High Risk)
        reconciliationRows.push({
          id: `missing-2b-${erp.stockInId}`,
          status: 'MISSING_IN_2B',
          statusLabel: 'Missing in GSTR-2B (Supplier Non-Filing)',
          supplierGstin: erp.supplierGstin,
          supplierName: erp.supplierName,
          supplierPhone: erp.supplierPhone,
          docType: 'INV',
          invoiceNumber: erp.invoiceNumber,
          invoiceDate: erp.invoiceDate.toISOString(),
          booksTaxable: erp.taxableValue,
          booksItc: erp.itcAmount,
          booksTotal: erp.totalAmount,
          stockInId: erp.stockInId,
          portalTaxable: null,
          portalItc: null,
          portalTotal: null,
          diffTaxable: erp.taxableValue,
          diffItc: erp.itcAmount,
        });
      }
    }

    // 4. Any remaining unmatched GSTR-2B entries -> Missing in Books (Unclaimed ITC)
    for (const portal of gstr2bEntries) {
      if (!matchedPortalIds.has(portal.id)) {
        const portalTaxable = Number(portal.taxableValue);
        const portalItc = Number(portal.igst) + Number(portal.cgst) + Number(portal.sgst);
        const portalTotal = Number(portal.totalAmount);

        reconciliationRows.push({
          id: `missing-books-${portal.id}`,
          status: 'MISSING_IN_BOOKS',
          statusLabel: 'Missing in Books (Unclaimed ITC)',
          supplierGstin: portal.supplierGstin,
          supplierName: portal.supplierName || portal.supplierGstin,
          docType: portal.docType,
          invoiceNumber: portal.invoiceNumber,
          invoiceDate: portal.invoiceDate.toISOString(),
          booksTaxable: null,
          booksItc: null,
          booksTotal: null,
          stockInId: null,
          portalTaxable,
          portalItc,
          portalTotal,
          diffTaxable: -portalTaxable,
          diffItc: -portalItc,
          itcAvailable: portal.itcAvailable,
          filingDate: portal.filingDate ? portal.filingDate.toISOString() : null,
          sourceSection: portal.sourceSection,
        });
      }
    }

    // 5. Aggregate KPI Totals
    const matchedRows = reconciliationRows.filter((r) => r.status === 'MATCHED');
    const missingIn2bRows = reconciliationRows.filter((r) => r.status === 'MISSING_IN_2B');
    const missingInBooksRows = reconciliationRows.filter((r) => r.status === 'MISSING_IN_BOOKS');
    const mismatchRows = reconciliationRows.filter(
      (r) => r.status === 'MISMATCH_VALUE' || r.status === 'MISMATCH_TAX',
    );

    const sumPortalItc = gstr2bEntries.reduce(
      (acc, p) => acc + (Number(p.igst) + Number(p.cgst) + Number(p.sgst)),
      0,
    );
    const sumPortalTaxable = gstr2bEntries.reduce((acc, p) => acc + Number(p.taxableValue), 0);

    const sumBooksItc = erpItems.reduce((acc, e) => acc + e.itcAmount, 0);
    const sumBooksTaxable = erpItems.reduce((acc, e) => acc + e.taxableValue, 0);

    const matchedItc = matchedRows.reduce((acc, r) => acc + (r.booksItc || 0), 0);
    const matchedTaxable = matchedRows.reduce((acc, r) => acc + (r.booksTaxable || 0), 0);

    const missingIn2bItc = missingIn2bRows.reduce((acc, r) => acc + (r.booksItc || 0), 0);
    const missingIn2bTaxable = missingIn2bRows.reduce((acc, r) => acc + (r.booksTaxable || 0), 0);

    const missingInBooksItc = missingInBooksRows.reduce((acc, r) => acc + (r.portalItc || 0), 0);
    const missingInBooksTaxable = missingInBooksRows.reduce((acc, r) => acc + (r.portalTaxable || 0), 0);

    const discrepancyItc = mismatchRows.reduce((acc, r) => acc + Math.abs(r.diffItc || 0), 0);

    return {
      period,
      financialYear: fy,
      totalGstr2bItc: Math.round(sumPortalItc * 100) / 100,
      totalGstr2bTaxable: Math.round(sumPortalTaxable * 100) / 100,
      totalBooksItc: Math.round(sumBooksItc * 100) / 100,
      totalBooksTaxable: Math.round(sumBooksTaxable * 100) / 100,
      matchedItc: Math.round(matchedItc * 100) / 100,
      matchedTaxable: Math.round(matchedTaxable * 100) / 100,
      missingIn2bItc: Math.round(missingIn2bItc * 100) / 100,
      missingIn2bTaxable: Math.round(missingIn2bTaxable * 100) / 100,
      missingInBooksItc: Math.round(missingInBooksItc * 100) / 100,
      missingInBooksTaxable: Math.round(missingInBooksTaxable * 100) / 100,
      discrepancyItc: Math.round(discrepancyItc * 100) / 100,
      discrepancyCount: mismatchRows.length,
      counts: {
        matched: matchedRows.length,
        missingIn2b: missingIn2bRows.length,
        missingInBooks: missingInBooksRows.length,
        mismatch: mismatchRows.length,
        total: reconciliationRows.length,
      },
      rows: reconciliationRows,
    };
  }

  /**
   * Generates a pre-formatted legal WhatsApp reminder message for a delinquent supplier.
   */
  public static buildWhatsAppReminder(row: ReconciliationRow): string {
    const invNo = row.invoiceNumber;
    const invDate = new Date(row.invoiceDate).toLocaleDateString('en-GB');
    const taxAmt = row.booksItc ? `₹${row.booksItc.toLocaleString('en-IN')}` : 'GST Amount';
    const totalAmt = row.booksTotal ? `₹${row.booksTotal.toLocaleString('en-IN')}` : '';

    return (
      `Dear ${row.supplierName || 'Valued Supplier'},\n\n` +
      `Greetings from RVP Industries Private Limited.\n\n` +
      `During our monthly GST Input Tax Credit (ITC) reconciliation under CGST Rule 36(4), we noticed that your invoice has *NOT appeared in our GSTR-2B*:\n\n` +
      `📄 *Invoice No:* ${invNo}\n` +
      `📅 *Date:* ${invDate}\n` +
      (totalAmt ? `💰 *Total Amount:* ${totalAmt}\n` : '') +
      `🏛️ *GST Paid by RVP:* ${taxAmt}\n` +
      `🏢 *Your GSTIN:* ${row.supplierGstin}\n\n` +
      `As per statutory GST compliance, we cannot claim ITC unless this invoice is filed in your GSTR-1. ` +
      `Kindly file/amend your GSTR-1 at the earliest to ensure seamless settlement of pending accounts.\n\n` +
      `Thank you for your cooperation.\n*Accounts Dept - RVP Industries*`
    );
  }
}
