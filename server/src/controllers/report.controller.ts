import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { computeFY } from '../lib/poNumber.js';

// ─────────────────────────────────────────────────────────────────────────────
// Statutory reports: GST (input/output for GSTR filing) and TDS (194Q credit
// deducted by buyers on our sales, for the income-tax return / Form 26AS match).
//
// Both are read-only aggregates over the existing sale/purchase/receipt data —
// nothing is persisted. They accept a ?from&to ISO date window (default: the
// current Indian financial year, Apr–Mar) and are reported on the tax-point
// date: invoice date for GST, deduction date for TDS.
// ─────────────────────────────────────────────────────────────────────────────

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Resolve the ?from&to window, defaulting to the running financial year. */
function resolvePeriod(req: Request): { from: Date; to: Date } {
  const now = new Date();
  const y = now.getFullYear();
  const fyStartYear = now.getMonth() >= 3 ? y : y - 1; // FY starts 1 Apr
  const defaultFrom = new Date(Date.UTC(fyStartYear, 3, 1, 0, 0, 0));
  const defaultTo = new Date(Date.UTC(fyStartYear + 1, 2, 31, 23, 59, 59));

  const fromRaw = typeof req.query.from === 'string' ? new Date(req.query.from) : null;
  const toRaw = typeof req.query.to === 'string' ? new Date(req.query.to) : null;

  const from = fromRaw && !isNaN(fromRaw.getTime()) ? fromRaw : defaultFrom;
  const to = toRaw && !isNaN(toRaw.getTime()) ? toRaw : defaultTo;
  // Make the end of the window inclusive of the whole day.
  to.setHours(23, 59, 59, 999);
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

  // ── Input tax: GST paid on purchase (supplier) invoices — the ITC we can
  //    claim. Computed on the actual stocked-in billing weight × PO price, the
  //    same basis the purchase statement / verification uses. ─────────────────
  const stockIns = await prisma.stockIn.findMany({
    where: {
      arrivalDate: { gte: from, lte: to },
      purchaseOrder: { hasGst: true },
    },
    include: { purchaseOrder: { include: { party: true } } },
    orderBy: { arrivalDate: 'asc' },
  });

  const purchaseLines = stockIns.map((s) => {
    const rate = Number(s.purchaseOrder.pricePerKg);
    const taxable = r2(s.billingWeightKg * rate);
    const gst = r2(taxable * 0.05); // seed purchase IGST @ 5%
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
      taxableValue: taxable,
      gstRate: 5,
      gstAmount: gst,
      ...splitTax(gst, intra),
      invoiceTotal: r2(taxable + gst),
    };
  });

  const sum = <T,>(rows: T[], pick: (r: T) => number) => r2(rows.reduce((a, r) => a + pick(r), 0));

  const outputGst = sum(salesLines, (l) => l.gstAmount);
  const dnGst = sum(dnLines, (l) => l.gstAmount);
  const cnGst = sum(cnLines, (l) => l.gstAmount);
  const inputGst = sum(purchaseLines, (l) => l.gstAmount);
  const netOutputTax = r2(outputGst + dnGst - cnGst);
  const netPayable = r2(netOutputTax - inputGst);

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
      taxableTotal: sum(purchaseLines, (l) => l.taxableValue),
      igstTotal: sum(purchaseLines, (l) => l.igst),
      cgstTotal: sum(purchaseLines, (l) => l.cgst),
      sgstTotal: sum(purchaseLines, (l) => l.sgst),
      gstTotal: inputGst,
    },
    summary: {
      outputTax: outputGst,
      creditNoteTax: cnGst,
      debitNoteTax: dnGst,
      netOutputTax,
      inputTaxCredit: inputGst,
      netPayable, // > 0 → pay to govt; < 0 → carried-forward ITC
    },
  });
}

// ── TDS report ───────────────────────────────────────────────────────────────
// TDS deducted BY buyers on our sales under Section 194Q (0.1% of the taxable
// sale value). This is a credit in our Form 26AS, claimed against income tax.
// A deduction is captured either on the collection receipt or, when a shipment
// was marked paid directly, on the dispatch — we count each exactly once, with
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

  // Dispatches whose TDS is already represented by a receipt row — suppress the
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
