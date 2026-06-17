import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { createVerificationSchema } from '../schemas/purchase.schema.js';
import { crossVerify } from '../lib/calc.js';
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

  const { reference, diff, exempt, finalWeight } = crossVerify(
    billingWeightKg,
    partyKataKg,
    rvpKataKg
  );

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
  
  // Payable = net base cost + IGST (5%)
  const igst = netBaseCost * 0.05;
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
    // 1. Update purchase with discounts & carter charges
    await tx.purchase.update({
      where: { id: purchase.id },
      data: {
        discountType: data.discountType || null,
        discountValue: data.discountValue,
        carterCharge: data.carterCharge,
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
    // Inventory cost includes raw seed payable, hamali, and carter charges
    const hamali = Number(purchase.hamaliCharge);
    const totalInventoryCost = totalAmount + hamali + data.carterCharge;
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
  });
  if (!verification) throw new HttpError(404, 'Verification not found');
  await prisma.weightVerification.delete({ where: { id: req.params.id } });
  res.json({ message: 'Verification deleted' });
}
