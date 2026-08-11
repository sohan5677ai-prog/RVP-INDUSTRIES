import { logger } from '../lib/logger.js';
import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import type { DiscountType, Prisma, WaLanguage } from '@prisma/client';
import { HttpError } from '../lib/httpError.js';
import { createVerificationSchema } from '../schemas/purchase.schema.js';
import {
  crossVerify,
  companyHamaliShare,
  hamaliSplit,
  computeQualityAdjustments,
  parseQualityAdjustments,
  qualityAdjustmentFreight,
  type QualityAdjustmentInput,
} from '../lib/calc.js';
import { InventoryService } from '../services/inventory.service.js';
import { LedgerService } from '../services/ledger.service.js';
import { whatsappService, resolveInternalCopyRecipients } from '../services/whatsapp.service.js';
import { buildPurchaseStatementData } from './purchaseStatement.controller.js';
import { renderPurchaseStatementPdf } from '../lib/purchaseStatementPdf.js';
import { uploadFileToStorage } from '../lib/upload.js';

/**
 * After a lorry is unloaded & weight-verified, WhatsApp the supplier the
 * "unloaded" confirmation with the full purchase statement attached (use case
 * #4) - every head of the bill (weighments, kata difference, quality/expense/
 * freight deductions, GST, billed-on costs, self-vehicle recoveries) plus their
 * running account balance. Fire-and-forget: rendering/upload/send never blocks
 * or fails the verification response.
 */
async function sendVerificationStatement(
  party: { id: string; name: string; phone: string | null; phone2?: string | null; waLanguage?: WaLanguage | null },
  details: { lorryNumber: string; netWeightKg: number; amount: number },
  verificationId: string
) {
  try {
    // Nothing to send to - skip the PDF work entirely. The internal members get
    // their own copy of this statement, so a supplier with no phone on file is
    // only a dead end when there's nobody internal to copy either.
    if (!party.phone && !party.phone2 && (await resolveInternalCopyRecipients()).length === 0) return;
    const statement = await buildPurchaseStatementData(verificationId);
    let url: string | undefined;
    let filename: string | undefined;
    if (statement) {
      const buffer = await renderPurchaseStatementPdf(statement);
      const invoiceBit = (statement.invoiceNumber || details.lorryNumber).replace(/[^\w]+/g, '-');
      filename = `Purchase-Statement-${party.name.replace(/[^\w]+/g, '-')}-${invoiceBit}.pdf`;
      url = await uploadFileToStorage({ originalname: filename, mimetype: 'application/pdf', buffer } as Express.Multer.File);
    }
    await whatsappService.notifyVerificationStatement(party, details, url, filename, verificationId);
  } catch (e) {
    logger.error('[whatsapp] verification statement failed', e);
  }
}

const verificationInclude = {
  purchase: {
    include: {
      stockIn: { include: { purchaseOrder: { include: { party: true } } } },
    },
  },
} as const;

export async function listVerifications(_req: Request, res: Response) {
  const verifications = await prisma.weightVerification.findMany({
    orderBy: { createdAt: 'desc' },
    include: verificationInclude,
  });
  res.json(verifications);
}

export async function getVerification(req: Request, res: Response) {
  const verification = await prisma.weightVerification.findUnique({
    where: { id: req.params.id },
    include: verificationInclude,
  });
  if (!verification) throw new HttpError(404, 'Verification not found');
  res.json(verification);
}

/**
 * Run weight cross-verification for a recorded Purchase. This is now a
 * standalone step (separate from recording the purchase). It computes the
 * payable balance to the supplier.
 *
 * NOTE: hamali (unloading) is NOT deducted from the supplier's balance - it is
 * borne by the transporter/lorry, not the party.
 */
export async function createVerification(req: Request, res: Response) {
  const data = createVerificationSchema.parse(req.body);

  const purchase = await prisma.purchase.findUnique({
    where: { id: data.purchaseId },
    include: { verification: true, stockIn: { include: { purchaseOrder: { include: { party: true } } } } },
  });
  if (!purchase) throw new HttpError(400, 'Purchase not found');
  if (purchase.verification) throw new HttpError(409, 'This purchase is already verified');

  // KNM company vehicles have no external transporter to recover the lorry's
  // hamali share from, so the seed bears the whole charge. The recording path
  // (purchase.controller) already capitalises the full charge with this flag; we
  // pass it here too so the subtract/add below faithfully mirror that cost.
  const { getCompanyProfileRow } = await import('./settings.controller.js');
  const { isVehicleExempt } = await import('../lib/calc.js');
  const companyProfile = await getCompanyProfileRow();
  const isCompanyVehicle = isVehicleExempt(purchase.stockIn.lorryNumber, companyProfile.companyVehicles);

  const billingWeightKg = purchase.stockIn.billingWeightKg;
  const partyKataKg = purchase.stockIn.partyKataKg;
  const rvpKataKg = purchase.netWeightKg;
  const pricePerKg = Number(purchase.stockIn.purchaseOrder.pricePerKg);

  let { reference, diff, exempt, finalWeight } = crossVerify(
    billingWeightKg,
    partyKataKg,
    rvpKataKg
  );

  if (data.forceExempt && !exempt) {
    exempt = true;
    finalWeight = reference;
  }

  // Quality adjustments: any number of deduction rows (weight/price/flat
  // quality discounts, recovered expenses, and lorry freight the party bears).
  // The Slack flow still posts the legacy single discountType/discountValue
  // pair, so fold that into a one-row list when no explicit list came in.
  const adjustmentInputs: QualityAdjustmentInput[] =
    data.qualityAdjustments ??
    (data.discountType && data.discountValue > 0
      ? [{ mode: data.discountType, value: data.discountValue }]
      : []);
  const qa = computeQualityAdjustments(adjustmentInputs, finalWeight, pricePerKg);
  const netBaseCost = qa.netBaseCost;

  // GST is charged on the invoice billing amount (billing weight x price), NOT
  // on our recalculated payable. Gross payable = net base cost + IGST (5%).
  const billingAmount = billingWeightKg * pricePerKg;
  const igst = purchase.stockIn.purchaseOrder.hasGst ? Math.round(billingAmount * 0.05 * 100) / 100 : 0;
  const grossPayable = netBaseCost + igst;

  // Self-vehicle: the party used their own lorry, so the lorry's ₹80/t hamali
  // share (normally recovered from the transporter) is deducted from their
  // payable. The seed's capitalised cost is unaffected - only the party balance
  // and the ledger's supplier credit change.
  const selfVehicleHamali = purchase.stockIn.selfVehicle
    ? hamaliSplit(Number(purchase.hamaliCharge), isCompanyVehicle).lorry
    : 0;
  // Self-vehicle: the party also bears the full weighbridge/kata fee (normally
  // recovered from the transporter). It comes off their payable AND lowers the
  // seed's landed cost (see totalInventoryCost below).
  const selfVehicleKata = purchase.stockIn.selfVehicle
    ? Number(purchase.kataFee)
    : 0;

  // Bill addables: extra costs the user itemises at approval (loading, brokerage,
  // misc). They ADD to the party's net payable and capitalise into the seed's
  // landed cost. Only positive-amount, labelled rows are kept.
  const billAddables = (data.billAddables ?? [])
    .filter((a) => a.label.trim() && a.amount > 0)
    .map((a) => ({ label: a.label.trim(), amount: a.amount }));
  const addablesTotal = billAddables.reduce((sum, a) => sum + a.amount, 0);

  const totalAmount = Math.max(0, grossPayable + addablesTotal - selfVehicleHamali - selfVehicleKata);

  // Shortage check for Auto Debit Note (shortage > 0.5%)
  const shortageKg = billingWeightKg - rvpKataKg;
  const toleranceExceeded = shortageKg > 0 && (shortageKg / billingWeightKg) > 0.005;
  const debitNoteAmount = toleranceExceeded ? shortageKg * pricePerKg : 0;
  const supplierName = purchase.stockIn.purchaseOrder.party.name;
  // Legacy mirror on the Purchase row. A single quality-discount row keeps its
  // exact old meaning (type + typed value); anything richer collapses to the
  // total ₹ knocked off, tagged AMOUNT. The ledger reads the full row list off
  // the verification, so these two are for display/back-compat only.
  const legacyRows = qa.rows.filter((r) => r.mode === 'WEIGHT' || r.mode === 'PRICE' || r.mode === 'AMOUNT');
  const isSingleLegacy = qa.rows.length === 1 && legacyRows.length === 1;
  const legacyDiscountType: DiscountType | null = isSingleLegacy
    ? (legacyRows[0].mode as DiscountType)
    : (qa.totalDeduction > 0 ? 'AMOUNT' : null);
  const legacyDiscountValue = isSingleLegacy ? legacyRows[0].value : qa.totalDeduction;

  const verification = await prisma.$transaction(async (tx) => {
    // 1. Update purchase with discounts
    await tx.purchase.update({
      where: { id: purchase.id },
      data: {
        discountType: legacyDiscountType,
        discountValue: legacyDiscountValue,
      },
    });

    // 2. Create verification
    const createdVerification = await tx.weightVerification.create({
      data: {
        purchaseId: purchase.id,
        billingWeightKg,
        partyKataKg,
        rvpKataKg,
        referenceKg: reference,
        diffKg: diff,
        exempt,
        finalWeightKg: finalWeight,
        pricePerKg,
        totalAmount,
        selfVehicleHamali,
        selfVehicleKata,
        billAddables,
        qualityAdjustments: qa.rows as unknown as Prisma.InputJsonValue,
      },
    });

    // 3. Update SiloInventory (Raw Black Seed MAP)
    // Adjust silo: subtract old purchase weight & cost, add new verified weight
    // & cost. Inventory value carries only the company's half of the hamali.
    const originalPrice = Number(purchase.stockIn.purchaseOrder.pricePerKg);
    const ourHamali = companyHamaliShare(Number(purchase.hamaliCharge), isCompanyVehicle);
    // Inward freight is fixed at purchase recording and carries through.
    const freight = Number(purchase.freightCharge);
    const originalCost = purchase.netWeightKg * originalPrice + ourHamali + freight;
    // Seed value is capitalised EXCLUDING GST (netBaseCost, not grossPayable) - the
    // input IGST is claimable tax credit, not stock cost. The self-vehicle hamali is
    // recovered from the party and does not lower the seed's cost; the self-vehicle
    // kata DOES lower the seed's landed cost (the party reimburses it). Bill
    // addables are extra acquisition costs, so they capitalise into the seed too
    // (mirrors the ledger's stock debit, which derives from totalAmount).
    // A FREIGHT quality adjustment came OFF netBaseCost (we pay the lorry rather
    // than the party) but the goods still cost that much landed, so add it back.
    // An EXPENSE adjustment stays deducted - the party genuinely bore it.
    const totalInventoryCost =
      netBaseCost + qa.freightAmount + addablesTotal - selfVehicleKata + ourHamali + freight;

    // Subtract original purchase stock from inventory
    await InventoryService.updateBlackSeedInventory(
      tx,
      purchase.stockIn.loadingLocation,
      -purchase.netWeightKg,
      -originalCost
    );

    // Add verified final stock to inventory
    await InventoryService.updateBlackSeedInventory(
      tx,
      purchase.stockIn.loadingLocation,
      finalWeight,
      totalInventoryCost
    );

    // 4. Post Ledger entry
    await LedgerService.postPurchaseVerification(tx, purchase.id);

    return createdVerification;
  });

  // Fetch full verification to return
  const fullVerification = await prisma.weightVerification.findUnique({
    where: { id: verification.id },
    include: verificationInclude,
  });

  res.status(201).json({
    ...fullVerification,
    debitNoteAmount: debitNoteAmount > 0 ? debitNoteAmount : null,
    debitNoteReason: debitNoteAmount > 0 ? `Weighbridge shortage of ${shortageKg} kg exceeded 0.5% tolerance limit.` : null
  });

  // WhatsApp the supplier: lorry unloaded + verified, with their statement attached.
  const notifyParty = purchase.stockIn.purchaseOrder.party;
  void sendVerificationStatement(
    { id: notifyParty.id, name: notifyParty.name, phone: notifyParty.phone, phone2: notifyParty.phone2, waLanguage: notifyParty.waLanguage },
    { lorryNumber: purchase.stockIn.lorryNumber, netWeightKg: finalWeight, amount: totalAmount },
    verification.id
  );
}

export async function deleteVerification(req: Request, res: Response) {
  const verification = await prisma.weightVerification.findUnique({
    where: { id: req.params.id },
    include: {
      purchase: {
        include: {
          stockIn: {
            include: {
              purchaseOrder: true,
            },
          },
        },
      },
    },
  });
  if (!verification) throw new HttpError(404, 'Verification not found');

  const { getCompanyProfileRow } = await import('./settings.controller.js');
  const { isVehicleExempt } = await import('../lib/calc.js');
  const companyProfile = await getCompanyProfileRow();
  const isCompanyVehicle = isVehicleExempt(verification.purchase.stockIn.lorryNumber, companyProfile.companyVehicles);

  await prisma.$transaction(async (tx) => {
    const purchase = verification.purchase;
    const location = purchase.stockIn.loadingLocation;
    // Mirror the flagged share used at recording/verification so this reversal is
    // exact for KNM company vehicles (full charge borne by the seed).
    const ourHamali = companyHamaliShare(Number(purchase.hamaliCharge), isCompanyVehicle);
    const freight = Number(purchase.freightCharge);
    // Reconstruct the seed value we capitalised at verification (GST-EXCLUSIVE).
    // totalAmount is net of the self-vehicle hamali and kata but still INCLUDES GST:
    // add the hamali back (it stayed in the seed), leave the kata out (it lowered the
    // landed cost), and subtract the IGST (it was parked in Input Tax Credit, not stock).
    const igst = purchase.stockIn.purchaseOrder.hasGst
      ? Math.round(Number(verification.billingWeightKg) * Number(verification.pricePerKg) * 0.05 * 100) / 100
      : 0;
    const selfHam = Number(verification.selfVehicleHamali);
    // A FREIGHT quality adjustment was added back into the seed at verification
    // (it left the party's payable but never left the landed cost), so it has to
    // come back out here too.
    const qaFreight = qualityAdjustmentFreight(parseQualityAdjustments(verification.qualityAdjustments));
    const verifiedCost =
      Number(verification.totalAmount) + qaFreight + selfHam + ourHamali + freight - igst;

    // 1. Subtract the verified weight and cost from SiloInventory
    await InventoryService.updateBlackSeedInventory(
      tx,
      location,
      -verification.finalWeightKg,
      -verifiedCost
    );

    // 2. Add back the original purchase weight and cost to SiloInventory
    const originalPrice = Number(purchase.stockIn.purchaseOrder.pricePerKg);
    const originalCost = purchase.netWeightKg * originalPrice + ourHamali + freight;

    await InventoryService.updateBlackSeedInventory(
      tx,
      location,
      purchase.netWeightKg,
      originalCost
    );

    // 4. Delete the weight verification record
    await tx.weightVerification.delete({ where: { id: req.params.id } });

    // 5. Reset ledger back to unverified state
    await tx.journalEntry.deleteMany({
      where: { reference: `PURCHASE-${purchase.id}` }
    });
  });

  res.json({ message: 'Verification deleted' });
}
