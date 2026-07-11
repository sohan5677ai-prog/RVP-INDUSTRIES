import { logger } from '../lib/logger.js';
import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { createVerificationSchema } from '../schemas/purchase.schema.js';
import { crossVerify, companyHamaliShare, hamaliSplit } from '../lib/calc.js';
import { InventoryService } from '../services/inventory.service.js';
import { LedgerService } from '../services/ledger.service.js';

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

  // Triple-mode discounts:
  let payableWeight = finalWeight;
  let payablePrice = pricePerKg;
  let discountAmount = 0;

  if (data.discountType === 'WEIGHT') {
    payableWeight = Math.max(0, finalWeight - data.discountValue);
    discountAmount = data.discountValue * pricePerKg;
  } else if (data.discountType === 'PRICE') {
    payablePrice = Math.max(0, pricePerKg - data.discountValue);
    discountAmount = finalWeight * data.discountValue;
  } else if (data.discountType === 'AMOUNT') {
    discountAmount = data.discountValue;
  }

  const basePayable = payableWeight * payablePrice;
  const netBaseCost = data.discountType === 'AMOUNT' ? Math.max(0, basePayable - discountAmount) : basePayable;

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
  const totalAmount = Math.max(0, grossPayable - selfVehicleHamali - selfVehicleKata);

  // Shortage check for Auto Debit Note (shortage > 0.5%)
  const shortageKg = billingWeightKg - rvpKataKg;
  const toleranceExceeded = shortageKg > 0 && (shortageKg / billingWeightKg) > 0.005;
  const debitNoteAmount = toleranceExceeded ? shortageKg * pricePerKg : 0;
  const supplierName = purchase.stockIn.purchaseOrder.party.name;
  const verification = await prisma.$transaction(async (tx) => {
    // 1. Update purchase with discounts
    await tx.purchase.update({
      where: { id: purchase.id },
      data: {
        discountType: data.discountType || null,
        discountValue: data.discountValue,
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
    // kata DOES lower the seed's landed cost (the party reimburses it).
    const totalInventoryCost = netBaseCost - selfVehicleKata + ourHamali + freight;

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
    const verifiedCost = Number(verification.totalAmount) + selfHam + ourHamali + freight - igst;

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
