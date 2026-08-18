import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import {
  EXEMPT_KG,
  PURCHASE_GST_PCT,
  computeQualityAdjustments,
  parseQualityAdjustments,
  purchaseGst,
  type QualityAdjustmentMode,
} from '../lib/calc.js';
import { getCompanyProfileRow } from './settings.controller.js';
import { renderPurchaseStatementPdf, type PurchaseStatementData } from '../lib/purchaseStatementPdf.js';
import { SUPPORTED_LANGUAGES, type StatementLanguage } from '../lib/i18n/purchaseStatement.js';

const LANG_CODES = new Set(SUPPORTED_LANGUAGES.map((l) => l.code));

function parseLang(value: unknown): StatementLanguage {
  return typeof value === 'string' && LANG_CODES.has(value as StatementLanguage)
    ? (value as StatementLanguage)
    : 'en';
}

/**
 * Assemble the per-lorry purchase statement (the supplier's settlement bill) for
 * one WeightVerification. Every figure is read back off the stored verification
 * so the WhatsApp PDF, the printable page and the party ledger agree exactly.
 */
export async function buildPurchaseStatementData(
  verificationId: string,
  lang: StatementLanguage = 'en'
): Promise<PurchaseStatementData | null> {
  const verification = await prisma.weightVerification.findUnique({
    where: { id: verificationId },
    include: {
      purchase: {
        include: { stockIn: { include: { purchaseOrder: { include: { party: true } } } } },
      },
    },
  });
  if (!verification) return null;

  const { purchase } = verification;
  const { stockIn } = purchase;
  const po = stockIn.purchaseOrder;
  const party = po.party;

  const profile = await getCompanyProfileRow();

  const netPayable = Number(verification.totalAmount);
  const pricePerKg = Number(verification.pricePerKg);

  // GST is charged on the invoice's taxable value, not on our recalculated
  // payable - mirrors createVerification. When the party billed at their base
  // rate, the tax basis rate differs from the price we pay them.
  const gstRate = PURCHASE_GST_PCT;
  const gst = purchaseGst({
    hasGst: po.hasGst,
    billingWeightKg: verification.billingWeightKg,
    pricePerKg,
    billingRatePerKg: verification.billingRatePerKg,
  });
  const gstAmount = gst.amount;

  // Verifications recorded before the multi-row feature only carry the legacy
  // single discountType/discountValue pair - rebuild the equivalent row so the
  // printed breakdown still adds up to the stored payable.
  let qualityAdjustments = parseQualityAdjustments(verification.qualityAdjustments);
  if (!qualityAdjustments.length && purchase.discountType && Number(purchase.discountValue) > 0) {
    qualityAdjustments = computeQualityAdjustments(
      [{ mode: purchase.discountType as QualityAdjustmentMode, value: Number(purchase.discountValue) }],
      verification.finalWeightKg,
      pricePerKg
    ).rows;
  }

  const billAddables = Array.isArray(verification.billAddables)
    ? (verification.billAddables as unknown as { label: string; amount: number }[]).filter(
        (a) => a && a.label && Number(a.amount) > 0
      )
    : [];

  return {
    company: {
      name: profile.name,
      address: profile.address,
      gstin: profile.gstin,
      contact: profile.contact,
    },
    party: {
      name: party.name,
      address: [party.address, party.city, party.state].filter(Boolean).join(', ') || null,
      gstin: party.gstin,
      phone: party.phone,
    },
    invoiceNumber: stockIn.invoiceNumber,
    statementDate: purchase.purchaseDate ?? stockIn.arrivalDate,
    lorryNumber: stockIn.lorryNumber,
    poNumber: po.poNumber,
    selfVehicle: stockIn.selfVehicle,
    weights: {
      billingKg: verification.billingWeightKg,
      partyKataKg: verification.partyKataKg,
      rvpKataKg: verification.rvpKataKg,
      referenceKg: verification.referenceKg,
      diffKg: verification.diffKg,
      exempt: verification.exempt,
      payableKg: verification.finalWeightKg,
    },
    allowanceKg: EXEMPT_KG,
    pricePerKg,
    qualityAdjustments,
    billAddables,
    gstRate,
    gstAmount,
    gstBasisKg: verification.billingWeightKg,
    // The ₹/kg the tax was computed on - equal to pricePerKg unless the party
    // invoiced at their base rate.
    gstBasisRate: gst.ratePerKg,
    selfVehicleHamali: Number(verification.selfVehicleHamali ?? 0),
    selfVehicleKata: Number(verification.selfVehicleKata ?? 0),
    netPayable,
    lang,
  };
}

/** GET /verifications/:id/statement.pdf - the same sheet the party gets on WhatsApp. */
export async function downloadPurchaseStatementPdf(req: Request, res: Response) {
  const lang = parseLang(req.query.lang);
  const data = await buildPurchaseStatementData(req.params.id, lang);
  if (!data) throw new HttpError(404, 'Verification not found');

  const buffer = await renderPurchaseStatementPdf(data);
  const slug = `${data.party.name}-${data.invoiceNumber || data.lorryNumber}`.replace(/[^\w]+/g, '-');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Purchase-Statement-${slug}.pdf"`);
  res.send(buffer);
}
