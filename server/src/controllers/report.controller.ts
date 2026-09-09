import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { computeFY } from '../lib/poNumber.js';
import { istFinancialYearStart } from '../lib/istDate.js';
import { PURCHASE_GST_PCT, purchaseGst } from '../lib/calc.js';

// ─────────────────────────────────────────────────────────────────────────────
// Statutory reports: GST (input/output for GSTR filing) and TDS (194Q credit
// deducted by buyers on our sales, for the income-tax return / Form 26AS match).
//
// Both are read-only aggregates over the existing sale/purchase/receipt data -
// nothing is persisted. They accept a ?from&to ISO date window (default: the
// current Indian financial year, Apr–Mar) and are reported on the tax-point
// date: invoice date for GST, deduction date for TDS.
// ─────────────────────────────────────────────────────────────────────────────

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Resolve the ?from&to window, defaulting to the running financial year. */
function resolvePeriod(req: Request): { from: Date; to: Date } {
  const now = new Date();
  const fyStartYear = istFinancialYearStart(now); // FY starts 1 Apr, IST
  const defaultFrom = new Date(Date.UTC(fyStartYear, 3, 1, 0, 0, 0));
  const defaultTo = new Date(Date.UTC(fyStartYear + 1, 2, 31, 23, 59, 59, 999));

  const fromRaw = typeof req.query.from === 'string' ? new Date(req.query.from) : null;
  const toRaw = typeof req.query.to === 'string' ? new Date(req.query.to) : null;

  const from = fromRaw && !isNaN(fromRaw.getTime()) ? fromRaw : defaultFrom;
  const to = toRaw && !isNaN(toRaw.getTime()) ? toRaw : defaultTo;
  // If only a date string (YYYY-MM-DD) was passed, make the end inclusive of the day.
  if (typeof req.query.to === 'string' && req.query.to.length <= 10) {
    to.setHours(23, 59, 59, 999);
  }
  return { from, to };
}

/** PAN embedded in a GSTIN (chars 3–12). Null when the GSTIN is missing/short. */
function panFromGstin(gstin: string | null | undefined): string | null {
  if (!gstin || gstin.length < 12) return null;
  return gstin.slice(2, 12).toUpperCase();
}

/** State code embedded in a GSTIN (first 2 chars). */
function stateCodeFromGstin(gstin: string | null | undefined): string | null {
  if (!gstin || gstin.length < 2) return null;
  return gstin.slice(0, 2);
}

// ── GST report ───────────────────────────────────────────────────────────────
export async function getGstReport(req: Request, res: Response) {
  const { from, to } = resolvePeriod(req);

  const company = await prisma.companyProfile.findUnique({ where: { id: 'default' } });
  const homeStateCode = company?.stateCode ?? null;

  // Whether a supply is intra-state (CGST+SGST) or inter-state (IGST). We bill
  // IGST by default (most buyers are out-of-state); a supply is intra-state only
  // when the counterparty's GSTIN clearly sits in our home state.
  const isIntraState = (partyGstin: string | null | undefined): boolean => {
    const partyCode = stateCodeFromGstin(partyGstin);
    return !!homeStateCode && !!partyCode && partyCode === homeStateCode;
  };

  const splitTax = (gst: number, intra: boolean) => ({
    igst: intra ? 0 : r2(gst),
    cgst: intra ? r2(gst / 2) : 0,
    sgst: intra ? r2(gst / 2) : 0,
  });

  // ── Output tax: GST charged on our sale invoices. Reported on the invoice
  //    date (falls back to dispatch date for not-yet-invoiced shipments). ──────
  const dispatches = await prisma.saleDispatch.findMany({
    where: {
      gstAmount: { gt: 0 },
      OR: [
        { invoiceDate: { gte: from, lte: to } },
        { AND: [{ invoiceDate: null }, { dispatchDate: { gte: from, lte: to } }] },
      ],
    },
    include: { saleOrder: { include: { buyer: true } } },
    orderBy: { dispatchDate: 'asc' },
  });

  const salesLines = dispatches.map((d) => {
    const rate = Number(d.saleOrder.ratePerKg);
    const taxable = r2(d.weightKg * rate);
    const gst = r2(Number(d.gstAmount));
    const intra = isIntraState(d.saleOrder.buyer.gstin);
    const taxDate = d.invoiceDate ?? d.dispatchDate;
    return {
      id: d.id,
      date: taxDate.toISOString(),
      invoiceNumber:
        d.invoiceNumber ?? (d.invoiceSeq && d.invoiceFy ? `${d.invoiceSeq}/${d.invoiceFy}` : null),
      partyName: d.saleOrder.buyer.name,
      gstin: d.saleOrder.buyer.gstin,
      stateName: d.saleOrder.buyer.state,
      product: d.saleOrder.product,
      weightKg: d.weightKg,
      taxableValue: taxable,
      gstRate: taxable > 0 ? r2((gst / taxable) * 100) : 0,
      gstAmount: gst,
      ...splitTax(gst, intra),
      invoiceTotal: r2(taxable + gst),
    };
  });

  // Credit/Debit notes adjust output tax already reported: CN reduces, DN raises.
  const creditNotes = await prisma.creditNote.findMany({
    where: { status: 'ISSUED', noteDate: { gte: from, lte: to } },
    include: { party: true },
    orderBy: { noteDate: 'asc' },
  });
  const debitNotes = await prisma.debitNote.findMany({
    where: { status: 'ISSUED', noteDate: { gte: from, lte: to } },
    include: { party: true },
    orderBy: { noteDate: 'asc' },
  });

  const mapNote = (n: (typeof creditNotes)[number]) => {
    const gst = r2(Number(n.gstAmount));
    const taxable = r2(Number(n.taxableValue));
    const intra = isIntraState(n.party.gstin);
    return {
      id: n.id,
      date: n.noteDate.toISOString(),
      noteNumber: n.noteNumber,
      partyName: n.party.name,
      gstin: n.party.gstin,
      reason: n.reason,
      taxableValue: taxable,
      gstRate: Number(n.gstRate),
      gstAmount: gst,
      ...splitTax(gst, intra),
      total: r2(Number(n.totalAmount)),
    };
  };
  const cnLines = creditNotes.map(mapNote);
  const dnLines = debitNotes.map(mapNote);

  // ── Input tax: GST paid on purchase (supplier) invoices - the ITC we can
  //    claim. Computed on the actual stocked-in billing weight × the rate the
  //    party billed (their base rate when it differs from the PO's delivery
  //    price), the same basis the purchase statement / verification uses.
  //    Statutory purchase GST tracking in ERP starts from FY 2026-27 (1 Apr 2026);
  //    FY 2025-26 carries forward the fixed closing ITC of 11,01,878 via openingItc. ──
  const GST_PURCHASES_START = new Date('2026-04-01T00:00:00.000Z');

  const stockIns =
    to < GST_PURCHASES_START
      ? []
      : await prisma.stockIn.findMany({
          where: {
            arrivalDate: { gte: from < GST_PURCHASES_START ? GST_PURCHASES_START : from, lte: to },
            purchaseOrder: { hasGst: true },
          },
          include: { purchaseOrder: { include: { party: true } } },
          orderBy: { arrivalDate: 'asc' },
        });

  const purchaseLines = stockIns.map((s) => {
    // Claiming ITC on the PO price when the invoice was raised at a lower base
    // rate would overstate the credit and break GSTR-2B matching.
    const { ratePerKg: rate, taxableValue: taxable, amount: gst } = purchaseGst({
      hasGst: true,
      billingWeightKg: s.billingWeightKg,
      pricePerKg: s.purchaseOrder.pricePerKg,
      billingRatePerKg: s.billingRatePerKg,
    });
    const intra = isIntraState(s.purchaseOrder.party.gstin);
    return {
      id: s.id,
      date: s.arrivalDate.toISOString(),
      invoiceNumber: s.invoiceNumber,
      poNumber: s.purchaseOrder.poNumber,
      partyName: s.purchaseOrder.party.name,
      gstin: s.purchaseOrder.party.gstin,
      stateName: s.purchaseOrder.party.state,
      weightKg: s.billingWeightKg,
      // The rate the ITC is claimed on - a base-billed invoice sits below the PO price.
      ratePerKg: rate,
      taxableValue: taxable,
      gstRate: PURCHASE_GST_PCT,
      gstAmount: gst,
      ...splitTax(gst, intra),
      invoiceTotal: r2(taxable + gst),
    };
  });

  const sum = <T,>(rows: T[], pick: (r: T) => number) => r2(rows.reduce((a, r) => a + pick(r), 0));

  // ── Prior-period ITC & Output Tax: calculate opening ITC brought forward ───
  const priorStockIns =
    from <= GST_PURCHASES_START
      ? []
      : await prisma.stockIn.findMany({
          where: {
            arrivalDate: { gte: GST_PURCHASES_START, lt: from },
            purchaseOrder: { hasGst: true },
          },
          include: { purchaseOrder: true },
        });
  const priorPurchasesGst = sum(priorStockIns, (s) => {
    const { amount: gst } = purchaseGst({
      hasGst: true,
      billingWeightKg: s.billingWeightKg,
      pricePerKg: s.purchaseOrder.pricePerKg,
      billingRatePerKg: s.billingRatePerKg,
    });
    return gst;
  });

  const priorDispatches = await prisma.saleDispatch.findMany({
    where: {
      gstAmount: { gt: 0 },
      OR: [
        { invoiceDate: { lt: from } },
        { AND: [{ invoiceDate: null }, { dispatchDate: { lt: from } }] },
      ],
    },
  });
  const priorDispatchesGst = sum(priorDispatches, (d) => Number(d.gstAmount));

  const priorCreditNotes = await prisma.creditNote.findMany({
    where: { status: 'ISSUED', noteDate: { lt: from } },
  });
  const priorCnGst = sum(priorCreditNotes, (n) => Number(n.gstAmount));

  const priorDebitNotes = await prisma.debitNote.findMany({
    where: { status: 'ISSUED', noteDate: { lt: from } },
  });
  const priorDnGst = sum(priorDebitNotes, (n) => Number(n.gstAmount));

  // The business operations and opening ITC start from FY 2025-26 (Apr 2025 onwards).
  // Prior financial years (FY 2024-25 and earlier) carry zero opening balance.
  const fyStartYear = istFinancialYearStart(from);
  const baseOpeningItc = fyStartYear >= 2025 && company?.openingItc ? Number(company.openingItc) : 0;
  const priorTotalItc = r2(baseOpeningItc + priorPurchasesGst);
  const priorNetOutput = r2(priorDispatchesGst + priorDnGst - priorCnGst);
  const openingItc = Math.max(0, r2(priorTotalItc - priorNetOutput));

  const outputGst = sum(salesLines, (l) => l.gstAmount);
  const dnGst = sum(dnLines, (l) => l.gstAmount);
  const cnGst = sum(cnLines, (l) => l.gstAmount);
  const currentInputGst = sum(purchaseLines, (l) => l.gstAmount);
  const totalInputTaxCredit = r2(openingItc + currentInputGst);
  const netOutputTax = r2(outputGst + dnGst - cnGst);
  const netPayable = r2(netOutputTax - totalInputTaxCredit);

  res.json({
    period: { from: from.toISOString(), to: to.toISOString(), fy: computeFY(from) },
    company: company
      ? { name: company.name, gstin: company.gstin, stateName: company.stateName, stateCode: company.stateCode }
      : null,
    output: {
      sales: salesLines,
      creditNotes: cnLines,
      debitNotes: dnLines,
      taxableTotal: sum(salesLines, (l) => l.taxableValue),
      igstTotal: sum(salesLines, (l) => l.igst),
      cgstTotal: sum(salesLines, (l) => l.cgst),
      sgstTotal: sum(salesLines, (l) => l.sgst),
      gstTotal: outputGst,
      cnGstTotal: cnGst,
      dnGstTotal: dnGst,
      netOutputTax,
    },
    input: {
      purchases: purchaseLines,
      openingItc,
      taxableTotal: sum(purchaseLines, (l) => l.taxableValue),
      igstTotal: sum(purchaseLines, (l) => l.igst),
      cgstTotal: sum(purchaseLines, (l) => l.cgst),
      sgstTotal: sum(purchaseLines, (l) => l.sgst),
      gstTotal: currentInputGst,
      totalItcAvailable: totalInputTaxCredit,
    },
    summary: {
      outputTax: outputGst,
      creditNoteTax: cnGst,
      debitNoteTax: dnGst,
      netOutputTax,
      openingItc,
      currentInputTaxCredit: currentInputGst,
      inputTaxCredit: totalInputTaxCredit,
      netPayable, // > 0 → pay to govt; < 0 → carried-forward ITC
    },
  });
}

// ── TDS report ───────────────────────────────────────────────────────────────
// TDS deducted BY buyers on our sales under Section 194Q (0.1% of the taxable
// sale value). This is a credit in our Form 26AS, claimed against income tax.
// A deduction is captured either on the collection receipt or, when a shipment
// was marked paid directly, on the dispatch - we count each exactly once, with
// the receipt taking precedence (mirrors the party-ledger dedup).
export async function getTdsReport(req: Request, res: Response) {
  const { from, to } = resolvePeriod(req);

  const receipts = await prisma.receipt.findMany({
    where: { tdsAmount: { gt: 0 }, date: { gte: from, lte: to } },
    include: {
      party: true,
      saleDispatch: { include: { saleOrder: { include: { buyer: true } } } },
    },
    orderBy: { date: 'asc' },
  });

  // Dispatches whose TDS is already represented by a receipt row - suppress the
  // dispatch-level line so the same rupees aren't counted twice.
  const receiptCoveredDispatchIds = new Set(
    receipts.map((r) => r.saleDispatchId).filter((id): id is string => !!id)
  );

  const dispatches = await prisma.saleDispatch.findMany({
    where: {
      tdsAmount: { gt: 0 },
      OR: [
        { receivedDate: { gte: from, lte: to } },
        { deliveredDate: { gte: from, lte: to } },
        { AND: [{ receivedDate: null }, { deliveredDate: null }, { dispatchDate: { gte: from, lte: to } }] },
      ],
    },
    include: { saleOrder: { include: { buyer: true } } },
    orderBy: { dispatchDate: 'asc' },
  });

  type Entry = {
    id: string;
    date: string;
    deductorName: string;
    gstin: string | null;
    pan: string | null;
    invoiceNumber: string | null;
    section: string;
    saleValue: number;
    tdsRate: number;
    tdsAmount: number;
    source: 'RECEIPT' | 'DISPATCH';
  };

  const invoiceLabel = (d: {
    invoiceNumber: string | null;
    invoiceSeq: number | null;
    invoiceFy: string | null;
  } | null | undefined) =>
    d?.invoiceNumber ?? (d?.invoiceSeq && d?.invoiceFy ? `${d.invoiceSeq}/${d.invoiceFy}` : null);

  const entries: Entry[] = [];

  for (const rec of receipts) {
    const tds = r2(Number(rec.tdsAmount));
    const d = rec.saleDispatch;
    const buyer = d?.saleOrder.buyer ?? rec.party;
    const saleValue = d ? r2(d.weightKg * Number(d.saleOrder.ratePerKg)) : 0;
    entries.push({
      id: `REC-${rec.id}`,
      date: rec.date.toISOString(),
      deductorName: buyer?.name ?? 'Unknown',
      gstin: buyer?.gstin ?? null,
      pan: panFromGstin(buyer?.gstin),
      invoiceNumber: invoiceLabel(d),
      section: '194Q',
      saleValue,
      tdsRate: saleValue > 0 ? r2((tds / saleValue) * 100) : 0.1,
      tdsAmount: tds,
      source: 'RECEIPT',
    });
  }

  for (const d of dispatches) {
    if (receiptCoveredDispatchIds.has(d.id)) continue;
    const tds = r2(Number(d.tdsAmount));
    const buyer = d.saleOrder.buyer;
    const saleValue = r2(d.weightKg * Number(d.saleOrder.ratePerKg));
    entries.push({
      id: `DISP-${d.id}`,
      date: (d.receivedDate ?? d.deliveredDate ?? d.dispatchDate).toISOString(),
      deductorName: buyer.name,
      gstin: buyer.gstin,
      pan: panFromGstin(buyer.gstin),
      invoiceNumber: invoiceLabel(d),
      section: '194Q',
      saleValue,
      tdsRate: saleValue > 0 ? r2((tds / saleValue) * 100) : 0.1,
      tdsAmount: tds,
      source: 'DISPATCH',
    });
  }

  entries.sort((a, b) => a.date.localeCompare(b.date));

  // Roll up by deductor (buyer) for the 26AS-style reconciliation summary.
  const byDeductorMap = new Map<
    string,
    { deductorName: string; gstin: string | null; pan: string | null; entryCount: number; saleValue: number; tdsAmount: number }
  >();
  for (const e of entries) {
    const key = e.gstin ?? e.deductorName;
    const row = byDeductorMap.get(key) ?? {
      deductorName: e.deductorName,
      gstin: e.gstin,
      pan: e.pan,
      entryCount: 0,
      saleValue: 0,
      tdsAmount: 0,
    };
    row.entryCount += 1;
    row.saleValue = r2(row.saleValue + e.saleValue);
    row.tdsAmount = r2(row.tdsAmount + e.tdsAmount);
    byDeductorMap.set(key, row);
  }
  const byDeductor = [...byDeductorMap.values()].sort((a, b) => b.tdsAmount - a.tdsAmount);

  const totalSaleValue = r2(entries.reduce((a, e) => a + e.saleValue, 0));
  const totalTds = r2(entries.reduce((a, e) => a + e.tdsAmount, 0));

  res.json({
    period: { from: from.toISOString(), to: to.toISOString(), fy: computeFY(from) },
    entries,
    byDeductor,
    summary: {
      totalSaleValue,
      totalTds,
      entryCount: entries.length,
      deductorCount: byDeductor.length,
    },
  });
}

// ── GSTR-1 & HSN Table 12 Report ─────────────────────────────────────────────
export async function getGstr1Report(req: Request, res: Response) {
  const { from, to } = resolvePeriod(req);
  const company = await prisma.companyProfile.findUnique({ where: { id: 'default' } });
  const homeStateCode = company?.stateCode ?? null;
  const gstin = company?.gstin || '';

  const isIntraState = (partyGstin: string | null | undefined): boolean => {
    const partyCode = stateCodeFromGstin(partyGstin);
    return !!homeStateCode && !!partyCode && partyCode === homeStateCode;
  };

  const splitTax = (gst: number, intra: boolean) => ({
    igst: intra ? 0 : r2(gst),
    cgst: intra ? r2(gst / 2) : 0,
    sgst: intra ? r2(gst / 2) : 0,
  });

  const taxRows = await prisma.productTaxInfo.findMany();
  const taxMap = new Map(taxRows.map((t) => [t.product, t]));

  // Dispatches in period
  const dispatches = await prisma.saleDispatch.findMany({
    where: {
      gstAmount: { gt: 0 },
      OR: [
        { invoiceDate: { gte: from, lte: to } },
        { AND: [{ invoiceDate: null }, { dispatchDate: { gte: from, lte: to } }] },
      ],
    },
    include: { saleOrder: { include: { buyer: true } } },
    orderBy: { dispatchDate: 'asc' },
  });

  // Credit notes and Debit notes
  const creditNotes = await prisma.creditNote.findMany({
    where: { status: 'ISSUED', noteDate: { gte: from, lte: to } },
    include: { party: true, saleDispatch: true },
    orderBy: { noteDate: 'asc' },
  });

  const debitNotes = await prisma.debitNote.findMany({
    where: { status: 'ISSUED', noteDate: { gte: from, lte: to } },
    include: { party: true, saleDispatch: true },
    orderBy: { noteDate: 'asc' },
  });

  // Delivery Challans for Table 13
  const challans = await prisma.deliveryChallan.findMany({
    where: { challanDate: { gte: from, lte: to } },
    orderBy: { challanDate: 'asc' },
  });

  const pad2 = (n: number) => String(n).padStart(2, '0');
  const fpMonth = from.getMonth() + 1;
  const fpYear = from.getFullYear();
  const fp = `${pad2(fpMonth)}${fpYear}`;

  const b2bMap = new Map<string, any[]>();
  const b2csMap = new Map<string, any>();
  const hsnMap = new Map<string, any>();

  for (const d of dispatches) {
    const buyer = d.saleOrder.buyer;
    const buyerGstin = (buyer.gstin || '').trim().toUpperCase();
    const rate = Number(d.saleOrder.ratePerKg);
    const taxable = r2(d.weightKg * rate);
    const gst = r2(Number(d.gstAmount));
    const intra = isIntraState(buyerGstin);
    const tax = splitTax(gst, intra);
    const invTotal = r2(taxable + gst);
    const gstRate = taxable > 0 ? Math.round((gst / taxable) * 100) : 5;
    const taxDate = d.invoiceDate ?? d.dispatchDate;
    const idt = `${pad2(taxDate.getDate())}-${pad2(taxDate.getMonth() + 1)}-${taxDate.getFullYear()}`;
    const inum = d.invoiceNumber || (d.invoiceSeq && d.invoiceFy ? `${d.invoiceSeq}/${d.invoiceFy}` : `DISP-${d.id.slice(-6)}`);
    const pos = (stateCodeFromGstin(buyerGstin) || String(company?.stateCode || '37')).padStart(2, '0');

    // Aggregate Table 12 HSN
    const taxInfo = taxMap.get(d.saleOrder.product as any);
    const hsnCode = taxInfo?.hsn?.replace(/\D/g, '') || '12099990';
    const productDesc = taxInfo?.description || `${d.saleOrder.product} Sale`;

    const hsnKey = `${hsnCode}_${gstRate}`;
    const hsnRow = hsnMap.get(hsnKey) || {
      num: hsnMap.size + 1,
      hsn_sc: hsnCode,
      desc: productDesc,
      uqc: 'KGS',
      qty: 0,
      val: 0,
      txval: 0,
      iamt: 0,
      camt: 0,
      samt: 0,
      csamt: 0,
      rt: gstRate,
    };
    hsnRow.qty = r2(hsnRow.qty + d.weightKg);
    hsnRow.txval = r2(hsnRow.txval + taxable);
    hsnRow.val = r2(hsnRow.val + invTotal);
    hsnRow.iamt = r2(hsnRow.iamt + tax.igst);
    hsnRow.camt = r2(hsnRow.camt + tax.cgst);
    hsnRow.samt = r2(hsnRow.samt + tax.sgst);
    hsnMap.set(hsnKey, hsnRow);

    const isRegistered = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(buyerGstin);

    if (isRegistered) {
      const invObj = {
        inum,
        idt,
        val: invTotal,
        pos,
        rchrg: 'N',
        etin: '',
        inv_typ: 'R',
        itms: [
          {
            num: 1,
            itm_det: {
              rt: gstRate,
              txval: taxable,
              ...(intra ? { camt: tax.cgst, samt: tax.sgst } : { iamt: tax.igst }),
              csamt: 0,
            },
          },
        ],
      };
      const list = b2bMap.get(buyerGstin) || [];
      list.push(invObj);
      b2bMap.set(buyerGstin, list);
    } else {
      const b2csKey = `${intra ? 'INTRA' : 'INTER'}_${pos}_${gstRate}`;
      const existing = b2csMap.get(b2csKey) || {
        sply_ty: intra ? 'INTRA' : 'INTER',
        pos,
        typ: 'OE',
        rt: gstRate,
        txval: 0,
        iamt: 0,
        camt: 0,
        samt: 0,
        csamt: 0,
      };
      existing.txval = r2(existing.txval + taxable);
      existing.iamt = r2(existing.iamt + tax.igst);
      existing.camt = r2(existing.camt + tax.cgst);
      existing.samt = r2(existing.samt + tax.sgst);
      b2csMap.set(b2csKey, existing);
    }
  }

  const b2b = Array.from(b2bMap.entries()).map(([ctin, inv]) => ({
    ctin,
    cflag: 'N',
    inv,
  }));

  const b2cs = Array.from(b2csMap.values());

  // Table 9B: CDNR (Credit/Debit Notes to Registered)
  const cdnrMap = new Map<string, any[]>();
  const processNote = (n: any, ntty: 'C' | 'D') => {
    const partyGstin = (n.party?.gstin || '').trim().toUpperCase();
    const isRegistered = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(partyGstin);
    if (!isRegistered) return;

    const taxable = r2(Number(n.taxableValue || 0));
    const gst = r2(Number(n.gstAmount || 0));
    const intra = isIntraState(partyGstin);
    const tax = splitTax(gst, intra);
    const total = r2(Number(n.totalAmount || 0));
    const rate = Number(n.gstRate || 5);
    const pos = (stateCodeFromGstin(partyGstin) || String(company?.stateCode || '37')).padStart(2, '0');
    const ndt = `${pad2(n.noteDate.getDate())}-${pad2(n.noteDate.getMonth() + 1)}-${n.noteDate.getFullYear()}`;

    const ntObj = {
      nt_num: n.noteNumber,
      nt_dt: ndt,
      val: total,
      pos,
      rchrg: 'N',
      ntty,
      itms: [
        {
          num: 1,
          itm_det: {
            rt: rate,
            txval: taxable,
            ...(intra ? { camt: tax.cgst, samt: tax.sgst } : { iamt: tax.igst }),
            csamt: 0,
          },
        },
      ],
    };
    const list = cdnrMap.get(partyGstin) || [];
    list.push(ntObj);
    cdnrMap.set(partyGstin, list);
  };

  creditNotes.forEach((cn) => processNote(cn, 'C'));
  debitNotes.forEach((dn) => processNote(dn, 'D'));

  const cdnr = Array.from(cdnrMap.entries()).map(([ctin, nt]) => ({
    ctin,
    cflag: 'N',
    nt,
  }));

  const hsnList = Array.from(hsnMap.values());

  const minMax = (items: { num?: string | null }[]) => {
    const valid = items.map((i) => i.num).filter(Boolean) as string[];
    if (valid.length === 0) return { from: '—', to: '—', total: 0 };
    return { from: valid[0], to: valid[valid.length - 1], total: valid.length };
  };

  const invRange = minMax(dispatches.map((d) => ({ num: d.invoiceNumber })));
  const cnRange = minMax(creditNotes.map((c) => ({ num: c.noteNumber })));
  const dnRange = minMax(debitNotes.map((d) => ({ num: d.noteNumber })));
  const dcRange = minMax(challans.map((c) => ({ num: c.challanNumber })));

  const doc_det = [
    {
      doc_num: 1,
      doc_typ: 'Invoices for outward supply',
      docs: [
        {
          num: 1,
          from: invRange.from,
          to: invRange.to,
          totnum: invRange.total,
          canc: 0,
          net_issue: invRange.total,
        },
      ],
    },
    {
      doc_num: 4,
      doc_typ: 'Credit Note',
      docs: [
        {
          num: 1,
          from: cnRange.from,
          to: cnRange.to,
          totnum: cnRange.total,
          canc: 0,
          net_issue: cnRange.total,
        },
      ],
    },
    {
      doc_num: 5,
      doc_typ: 'Debit Note',
      docs: [
        {
          num: 1,
          from: dnRange.from,
          to: dnRange.to,
          totnum: dnRange.total,
          canc: 0,
          net_issue: dnRange.total,
        },
      ],
    },
    {
      doc_num: 6,
      doc_typ: 'Delivery Challan',
      docs: [
        {
          num: 1,
          from: dcRange.from,
          to: dcRange.to,
          totnum: dcRange.total,
          canc: challans.filter((c) => c.status === 'CANCELLED').length,
          net_issue: challans.filter((c) => c.status !== 'CANCELLED').length,
        },
      ],
    },
  ];

  const offlineJson = {
    gstin,
    fp,
    version: 'GST1.0',
    hash: 'hash',
    b2b,
    b2cs,
    cdnr,
    hsn: { data: hsnList },
    doc_issue: { doc_det },
  };

  const summary = {
    fp,
    period: { from: from.toISOString(), to: to.toISOString() },
    b2bInvoicesCount: dispatches.filter((d) => /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test((d.saleOrder.buyer.gstin || '').trim())).length,
    b2csInvoicesCount: dispatches.filter((d) => !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test((d.saleOrder.buyer.gstin || '').trim())).length,
    creditNotesCount: creditNotes.length,
    debitNotesCount: debitNotes.length,
    totalTaxableValue: r2(hsnList.reduce((acc, h) => acc + h.txval, 0)),
    totalIgst: r2(hsnList.reduce((acc, h) => acc + h.iamt, 0)),
    totalCgst: r2(hsnList.reduce((acc, h) => acc + h.camt, 0)),
    totalSgst: r2(hsnList.reduce((acc, h) => acc + h.samt, 0)),
    totalTax: r2(hsnList.reduce((acc, h) => acc + h.iamt + h.camt + h.samt, 0)),
    totalInvoiceValue: r2(hsnList.reduce((acc, h) => acc + h.val, 0)),
    hsnTable: hsnList,
    docTable: doc_det,
  };

  res.json({
    success: true,
    summary,
    offlineJson,
  });
}
