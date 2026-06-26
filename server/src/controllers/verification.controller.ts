import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { createVerificationSchema } from '../schemas/purchase.schema.js';
import { crossVerify, companyHamaliShare } from '../lib/calc.js';
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
 * NOTE: hamali (unloading) is NOT deducted from the supplier's balance — it is
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
  // on our recalculated payable. Payable = net base cost + IGST (5%).
  const billingAmount = billingWeightKg * pricePerKg;
  const igst = Math.round(billingAmount * 0.05 * 100) / 100;
  const totalAmount = netBaseCost + igst;

  // Shortage check for Auto Debit Note (shortage > 0.5%)
  const shortageKg = billingWeightKg - rvpKataKg;
  const toleranceExceeded = shortageKg > 0 && (shortageKg / billingWeightKg) > 0.005;
  const debitNoteAmount = toleranceExceeded ? shortageKg * pricePerKg : 0;
  const supplierName = purchase.stockIn.purchaseOrder.party.name;

  if (debitNoteAmount > 0) {
    console.log(`[DEBIT NOTE ENGINE] Auto-generating and emailing Debit Note of ₹${debitNoteAmount.toFixed(2)} to supplier "${supplierName}" due to shortage of ${shortageKg} kg (> 0.5% tolerance).`);
  }

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
      },
    });

    // 3. Update SiloInventory (Raw Black Seed MAP)
    // Adjust silo: subtract old purchase weight & cost, add new verified weight
    // & cost. Inventory value carries only the company's half of the hamali.
    const originalPrice = Number(purchase.stockIn.purchaseOrder.pricePerKg);
    const ourHamali = companyHamaliShare(Number(purchase.hamaliCharge));
    // Bag-cutting + inward freight are fixed at purchase recording and carry through.
    const bagCut = Number(purchase.bagCuttingCharge);
    const freight = Number(purchase.freightCharge);
    const originalCost = purchase.netWeightKg * originalPrice + ourHamali + bagCut + freight;
    const totalInventoryCost = totalAmount + ourHamali + bagCut + freight;

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

  await prisma.$transaction(async (tx) => {
    const purchase = verification.purchase;
    const location = purchase.stockIn.loadingLocation;
    const ourHamali = companyHamaliShare(Number(purchase.hamaliCharge));
    const bagCut = Number(purchase.bagCuttingCharge);
    const freight = Number(purchase.freightCharge);
    const verifiedCost = Number(verification.totalAmount) + ourHamali + bagCut + freight;

    // 1. Subtract the verified weight and cost from SiloInventory
    await InventoryService.updateBlackSeedInventory(
      tx,
      location,
      -verification.finalWeightKg,
      -verifiedCost
    );

    // 2. Add back the original purchase weight and cost to SiloInventory
    const originalPrice = Number(purchase.stockIn.purchaseOrder.pricePerKg);
    const originalCost = purchase.netWeightKg * originalPrice + ourHamali + bagCut + freight;

    await InventoryService.updateBlackSeedInventory(
      tx,
      location,
      purchase.netWeightKg,
      originalCost
    );

    // 3. Cleanup processing if it exists
    const processing = await tx.processing.findUnique({
      where: { purchaseId: verification.purchaseId },
    });
    if (processing) {
      await tx.processing.delete({ where: { id: processing.id } });
    }

    // 4. Delete the weight verification record
    await tx.weightVerification.delete({ where: { id: req.params.id } });
  });

  res.json({ message: 'Verification deleted' });
}
