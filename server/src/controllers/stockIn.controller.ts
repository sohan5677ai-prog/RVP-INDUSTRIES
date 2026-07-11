import { logger } from '../lib/logger.js';
import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { createStockInSchema, createUrpStockInSchema } from '../schemas/purchase.schema.js';
import { fileUrl } from '../lib/upload.js';
import { extractInvoiceData, type DocumentKind } from '../lib/gemini.js';

/**
 * Fully unwind a Purchase that was recorded off a StockIn so the stock-in can be
 * edited or deleted afterwards. Reverts the black-seed inventory this purchase
 * put into the silo (verified weight/cost if verified, else the raw purchase
 * weight/cost), removes any milled Processing, voids the verification ledger
 * entry, and deletes the WeightVerification + Purchase rows. Mirrors the teardown
 * in deletePurchase/deleteVerification so the books stay consistent. Does NOT
 * touch the StockIn record itself - the caller resets or deletes it.
 */
async function rollbackPurchaseForStockIn(tx: Prisma.TransactionClient, purchaseId: string) {
  const { InventoryService } = await import('../services/inventory.service.js');
  const { companyHamaliShare } = await import('../lib/calc.js');

  const purchase = await tx.purchase.findUnique({
    where: { id: purchaseId },
    include: {
      verification: true,
      processing: true,
      stockIn: { include: { purchaseOrder: true } },
    },
  });
  if (!purchase) return;

  const location = purchase.stockIn.loadingLocation;
  const pricePerKg = Number(purchase.stockIn.purchaseOrder.pricePerKg);
  const ourHamali = companyHamaliShare(Number(purchase.hamaliCharge));
  const freight = Number(purchase.freightCharge);

  // 1. Remove whatever weight/cost this purchase contributed to the silo.
  if (purchase.verification) {
    // Reconstruct the GST-EXCLUSIVE seed value. totalAmount is net of the self-
    // vehicle hamali AND kata but still includes GST: add the hamali back (it stayed
    // in the seed), leave the kata out, and subtract the IGST (parked in Input Tax
    // Credit, not stock).
    const igst = purchase.stockIn.purchaseOrder.hasGst
      ? Math.round(Number(purchase.verification.billingWeightKg) * Number(purchase.verification.pricePerKg) * 0.05 * 100) / 100
      : 0;
    const selfHam = Number(purchase.verification.selfVehicleHamali);
    const verifiedCost = Number(purchase.verification.totalAmount) + selfHam + ourHamali + freight - igst;
    await InventoryService.updateBlackSeedInventory(
      tx, location, -purchase.verification.finalWeightKg, -verifiedCost,
    );
  } else {
    const originalCost = purchase.netWeightKg * pricePerKg + ourHamali + freight;
    await InventoryService.updateBlackSeedInventory(
      tx, location, -purchase.netWeightKg, -originalCost,
    );
  }

  // 2. Remove downstream rows first (FK order): processing → verification.
  if (purchase.processing) {
    await tx.processing.delete({ where: { id: purchase.processing.id } });
  }
  if (purchase.verification) {
    await tx.weightVerification.delete({ where: { id: purchase.verification.id } });
  }

  // 3. Void the verification ledger journal entry (lines cascade on delete).
  await tx.journalEntry.deleteMany({ where: { reference: `PURCHASE-${purchase.id}` } });

  // 4. Finally the purchase itself.
  await tx.purchase.delete({ where: { id: purchase.id } });
}
export async function listStockIns(_req: Request, res: Response) {
  const stockIns = await prisma.stockIn.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      purchaseOrder: { include: { party: true } },
      purchase: { include: { verification: true, processing: true } },
    },
  });
  res.json(stockIns);
}

export async function getStockIn(req: Request, res: Response) {
  const stockIn = await prisma.stockIn.findUnique({
    where: { id: req.params.id },
    include: {
      purchaseOrder: { include: { party: true } },
      purchase: { include: { verification: true, processing: true } },
    },
  });
  if (!stockIn) throw new HttpError(404, 'Stock-in not found');
  res.json(stockIn);
}

/**
 * Read an uploaded invoice (image/PDF) with Gemini and return the fields it
 * could extract, so the client can pre-fill the stock-in form. Does not persist
 * anything - the file is held in memory only for the duration of the call.
 */
export async function extractStockInInvoice(req: Request, res: Response) {
  if (!req.file) throw new HttpError(400, 'Document file is required');
  const allowed: DocumentKind[] = ['invoice', 'partyKata', 'rvpWeight', 'rvpSecondWeight'];
  const kind = (req.body?.kind as DocumentKind) ?? 'invoice';
  if (!allowed.includes(kind)) throw new HttpError(400, 'Invalid document kind');

  // For an invoice, give Gemini the suppliers behind currently-pending POs so it
  // can map the seller to one of our master parties (handling abbreviations etc).
  let candidates: string[] = [];
  if (kind === 'invoice') {
    const pendingPOs = await prisma.purchaseOrder.findMany({
      where: { status: 'PENDING' },
      select: { party: { select: { name: true } } },
    });
    candidates = [...new Set(pendingPOs.map((po) => po.party?.name).filter((n): n is string => !!n))];
  }

  const data = await extractInvoiceData(req.file.buffer, req.file.mimetype, kind, candidates);
  logger.info(`[extract:${kind}]`, JSON.stringify(data));
  res.json(data);
}

export async function createStockIn(req: Request, res: Response) {
  const data = createStockInSchema.parse(req.body);

  // Previous stage must exist and not already have reached its lorryCount limit.
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: data.purchaseOrderId },
    include: { stockIns: true },
  });
  if (!po) throw new HttpError(400, 'Purchase order not found');
  
  const arrivedCount = po.stockIns.length;
  const lorryCount = po.lorryCount || Math.max(1, Math.round(po.tonnageKg / 25000));
  if (arrivedCount >= lorryCount) {
    throw new HttpError(409, `All ${lorryCount} expected lorries have already arrived for this PO`);
  }

  const rvpSecondWeightKg = data.rvpSecondWeightKg ?? 0;
  const rvpKataKg = rvpSecondWeightKg > 0 ? (data.rvpFirstWeightKg - rvpSecondWeightKg) : 0;

  const stockIn = await prisma.$transaction(async (tx) => {
    const created = await tx.stockIn.create({
      data: {
        purchaseOrderId: data.purchaseOrderId,
        arrivalDate: data.arrivalDate,
        lorryNumber: data.lorryNumber,
        invoiceNumber: data.invoiceNumber,
        rvpFirstWeightKg: data.rvpFirstWeightKg,
        rvpSecondWeightKg: data.rvpSecondWeightKg,
        rvpKataKg,
        billingWeightKg: data.billingWeightKg,
        partyKataKg: data.partyKataKg,
        invoiceFileUrl: req.file ? fileUrl(req.file.filename) : "",
        loadingLocation: data.loadingLocation,
        // Only BASE-priced POs carry inward freight; DELIVERY already includes it.
        freightCharge: po.priceType === 'BASE' ? data.freightCharge : 0,
        selfVehicle: data.selfVehicle,
      },
    });

    const nextStatus = (arrivedCount + 1 >= lorryCount) ? 'ARRIVED' : 'PENDING';
    await tx.purchaseOrder.update({
      where: { id: data.purchaseOrderId },
      data: {
        status: nextStatus,
      },
    });

    return created;
  });

  res.json(stockIn);
}

export async function createUrpStockIn(req: Request, res: Response) {
  const data = createUrpStockInSchema.parse(req.body);

  const rvpSecondWeightKg = data.rvpSecondWeightKg ?? 0;
  const rvpKataKg = rvpSecondWeightKg > 0 ? (data.rvpFirstWeightKg - rvpSecondWeightKg) : 0;
  if (rvpSecondWeightKg > 0 && rvpSecondWeightKg >= data.rvpFirstWeightKg) {
    throw new HttpError(400, 'RVP second weight must be less than first weight');
  }

  // Dummy invoice string if they didn't provide one (due to no GST)
  const invoiceNumber = data.invoiceNumber || `URP-${new Date().toISOString().split('T')[0]}-${Math.floor(Math.random() * 1000)}`;
  const gstAmount = data.hasGst ? (rvpKataKg * data.pricePerKg * 0.05) : 0;

  // A URP entry captures both weighments up front, so when a valid 2nd weight is
  // present we auto-record the Purchase here (same as the Purchases page would),
  // sending the arrival straight to the Verification stage instead of leaving it
  // parked on the Stock In page. With no 2nd weight it stays at stock-in.
  const willRecordPurchase = rvpKataKg > 0;
  let hamaliRate = 0, hamaliCharge = 0, kataFee = 0;
  if (willRecordPurchase) {
    const { getCompanyProfileRow, getHamaliRate } = await import('./settings.controller.js');
    const { calcHamali, calcKataFee, isVehicleExempt } = await import('../lib/calc.js');
    const companyProfile = await getCompanyProfileRow();
    const isCompanyVehicle = isVehicleExempt(data.lorryNumber, companyProfile.companyVehicles);
    hamaliRate = await getHamaliRate('BLACK_SEED_UNLOAD');
    hamaliCharge = calcHamali(rvpKataKg, hamaliRate, isCompanyVehicle);
    kataFee = calcKataFee(rvpKataKg, isCompanyVehicle);
  }

  const stockIn = await prisma.$transaction(async (tx) => {
    // 1. Create a 1-lorry PO behind the scenes
    const po = await tx.purchaseOrder.create({
      data: {
        poDate: data.arrivalDate,
        partyId: data.partyId,
        pricePerKg: data.pricePerKg,
        priceType: data.priceType,
        tonnageKg: rvpKataKg, // Accurate arrived weight
        hasGst: data.hasGst,
        gstAmount,
        lorryCount: 1,
        status: 'ARRIVED', // Instantly completed/arrived
        createdBy: 'URP_DIRECT',
        poNumber: `URP-${new Date().getTime().toString().slice(-6)}`, // generate unique identifier
      }
    });

    // 2. Create the StockIn linked to it
    const freightCharge = po.priceType === 'BASE' ? data.freightCharge : 0;
    const created = await tx.stockIn.create({
      data: {
        purchaseOrderId: po.id,
        arrivalDate: data.arrivalDate,
        lorryNumber: data.lorryNumber,
        invoiceNumber,
        rvpFirstWeightKg: data.rvpFirstWeightKg,
        rvpSecondWeightKg,
        rvpKataKg,
        billingWeightKg: data.billingWeightKg,
        partyKataKg: data.partyKataKg,
        invoiceFileUrl: req.file ? fileUrl(req.file.filename) : "",
        loadingLocation: data.loadingLocation,
        freightCharge,
        selfVehicle: data.selfVehicle,
      },
    });

    // 3. Auto-record the Purchase (net weight, hamali, kata) and capitalise the
    // seed into inventory - mirrors createPurchase so Verification picks it up.
    if (willRecordPurchase) {
      const { InventoryService } = await import('../services/inventory.service.js');
      const { companyHamaliShare } = await import('../lib/calc.js');
      await tx.purchase.create({
        data: {
          stockInId: created.id,
          netWeightKg: rvpKataKg,
          hamaliRate,
          hamaliCharge,
          kataFee,
          freightCharge,
        },
      });
      const originalCost =
        rvpKataKg * data.pricePerKg + companyHamaliShare(hamaliCharge) + freightCharge;
      await InventoryService.updateBlackSeedInventory(tx, created.loadingLocation, rvpKataKg, originalCost);
    }

    return created;
  });

  res.json(stockIn);
}

export async function updateStockIn(req: Request, res: Response) {
  const data = createStockInSchema.parse(req.body);
  const stockIn = await prisma.stockIn.findUnique({
    where: { id: req.params.id },
    include: { purchase: true, purchaseOrder: true },
  });
  if (!stockIn) throw new HttpError(404, 'Stock-in not found');

  const invoiceFileUrl = req.file ? fileUrl(req.file.filename) : stockIn.invoiceFileUrl;

  const rvpSecondWeightKg = data.rvpSecondWeightKg ?? 0;
  const rvpKataKg = rvpSecondWeightKg > 0 ? (data.rvpFirstWeightKg - rvpSecondWeightKg) : 0;

  const updated = await prisma.$transaction(async (tx) => {
    // If this stock-in was already purchased (and maybe verified), unwind that
    // chain first - inventory/ledger reverted - so the edit starts from a clean
    // slate. The stock-in then returns to "awaiting purchase" and the purchase
    // is re-recorded afterwards.
    if (stockIn.purchase) {
      await rollbackPurchaseForStockIn(tx, stockIn.purchase.id);
    }

    return tx.stockIn.update({
      where: { id: req.params.id },
      data: {
        arrivalDate: data.arrivalDate,
        lorryNumber: data.lorryNumber,
        invoiceNumber: data.invoiceNumber,
        rvpFirstWeightKg: data.rvpFirstWeightKg,
        rvpSecondWeightKg: data.rvpSecondWeightKg,
        rvpKataKg,
        billingWeightKg: data.billingWeightKg,
        partyKataKg: data.partyKataKg,
        invoiceFileUrl,
        loadingLocation: data.loadingLocation,
        freightCharge: stockIn.purchaseOrder.priceType === 'BASE' ? data.freightCharge : 0,
        selfVehicle: data.selfVehicle,
      },
    });
  });

  res.json(updated);
}

export async function deleteStockIn(req: Request, res: Response) {
  const stockIn = await prisma.stockIn.findUnique({
    where: { id: req.params.id },
    include: { purchase: true, purchaseOrder: true },
  });
  if (!stockIn) throw new HttpError(404, 'Stock-in not found');

  await prisma.$transaction(async (tx) => {
    // Unwind the purchase chain (inventory/ledger/verification/processing) if this
    // arrival was already purchased, so deleting it leaves the books consistent.
    if (stockIn.purchase) {
      await rollbackPurchaseForStockIn(tx, stockIn.purchase.id);
    }

    await tx.stockIn.delete({ where: { id: req.params.id } });

    // A Direct-Inward (URP) arrival owns a synthetic 1-lorry PO - remove it with
    // the stock-in rather than leaving a phantom PENDING order. Real POs go back
    // to PENDING so the arrival can be re-recorded.
    if (stockIn.purchaseOrder.createdBy === 'URP_DIRECT' || stockIn.purchaseOrder.createdBy === 'KNM_BATCH') {
      await tx.purchaseOrder.delete({ where: { id: stockIn.purchaseOrderId } });
    } else {
      await tx.purchaseOrder.update({
        where: { id: stockIn.purchaseOrderId },
        data: { status: 'PENDING' },
      });
    }
  });
  res.json({ message: 'Stock-in deleted' });
}

/**
 * Batch-import cold-storage arrivals (KNM Multi) in one shot.
 * For each row, creates PO + StockIn + Purchase + WeightVerification and posts
 * the purchase ledger entry - the entire flow that would normally span four
 * pages. All weights are treated as the cold-storage receipt weight (no RVP
 * weighbridge), so billing = party kata = RVP kata = final weight, and the
 * verification is auto-approved (diffKg = 0, exempt = true).
 */
export async function createColdStorageBatch(req: Request, res: Response) {
  interface BatchRow {
    date: string;
    partyId: string;
    lorryNo: string;
    tonnes: number;
    pricePerKg: number;
    location?: string;
  }

  const rows = req.body.rows as BatchRow[];
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new HttpError(400, 'rows must be a non-empty array');
  }

  const { getCompanyProfileRow, getHamaliRate } = await import('./settings.controller.js');
  const { calcHamali, calcKataFee, isVehicleExempt, companyHamaliShare } = await import('../lib/calc.js');
  const { InventoryService } = await import('../services/inventory.service.js');
  const { LedgerService } = await import('../services/ledger.service.js');

  const companyProfile = await getCompanyProfileRow();
  const hamaliRate = await getHamaliRate('BLACK_SEED_UNLOAD');

  const results: Array<{ success: boolean; poNumber?: string; error?: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const storageLocation = row.location ?? 'KNM Multi';
      const locationTag = storageLocation === 'Murugan' ? 'MRG' : storageLocation === 'PGR COLD' ? 'PGR' : 'KNM';
      const weightKg = Math.round(row.tonnes * 1000);
      const pricePerKg = row.pricePerKg;
      const arrivalDate = new Date(row.date);
      const dateTag = arrivalDate.toISOString().slice(0, 10).replace(/-/g, '');
      const poNumber = `${locationTag}-${dateTag}-${Date.now().toString().slice(-6)}`;
      const invoiceNumber = `${locationTag}-${dateTag}-${String(i + 1).padStart(3, '0')}`;

      const isCompanyVehicle = isVehicleExempt(row.lorryNo, companyProfile.companyVehicles);
      const hamaliCharge = calcHamali(weightKg, hamaliRate, isCompanyVehicle);
      const kataFee = calcKataFee(weightKg, isCompanyVehicle);
      const ourHamali = companyHamaliShare(hamaliCharge);

      // For cold storage: no GST, no discounts, no self-vehicle deductions.
      const originalCost = weightKg * pricePerKg + ourHamali;
      const totalAmount = weightKg * pricePerKg; // supplier payable

      const result = await prisma.$transaction(async (tx) => {
        // 1. Create one-lorry PO (synthetic, like URP)
        const po = await tx.purchaseOrder.create({
          data: {
            poDate: arrivalDate,
            partyId: row.partyId,
            pricePerKg,
            priceType: 'DELIVERY',
            tonnageKg: weightKg,
            hasGst: false,
            gstAmount: 0,
            lorryCount: 1,
            status: 'ARRIVED',
            createdBy: 'KNM_BATCH',
            poNumber,
          },
        });

        // 2. StockIn - all weights = cold-storage receipt weight (no RVP weighbridge)
        const stockIn = await tx.stockIn.create({
          data: {
            purchaseOrderId: po.id,
            arrivalDate,
            lorryNumber: row.lorryNo,
            invoiceNumber,
            rvpFirstWeightKg: weightKg,
            rvpSecondWeightKg: 0,
            rvpKataKg: weightKg,
            billingWeightKg: weightKg,
            partyKataKg: weightKg,
            invoiceFileUrl: '',
            loadingLocation: storageLocation,
            freightCharge: 0,
            selfVehicle: false,
          },
        });

        // 3. Purchase (hamali + kata computed from net weight)
        const purchase = await tx.purchase.create({
          data: {
            stockInId: stockIn.id,
            netWeightKg: weightKg,
            hamaliRate,
            hamaliCharge,
            kataFee,
            freightCharge: 0,
          },
        });

        // 4. Preliminary inventory (mirrors createPurchase)
        await InventoryService.updateBlackSeedInventory(tx, storageLocation, weightKg, originalCost);

        // 5. WeightVerification - auto-approved (all weights equal)
        await tx.weightVerification.create({
          data: {
            purchaseId: purchase.id,
            billingWeightKg: weightKg,
            partyKataKg: weightKg,
            rvpKataKg: weightKg,
            referenceKg: weightKg,
            diffKg: 0,
            exempt: true,
            finalWeightKg: weightKg,
            pricePerKg,
            totalAmount,
            selfVehicleHamali: 0,
            selfVehicleKata: 0,
          },
        });

        // 6. Adjust inventory: subtract preliminary, add verified
        //    Net effect = 0 for cold storage (no discounts/self-vehicle), but
        //    kept to mirror the normal verification flow exactly.
        await InventoryService.updateBlackSeedInventory(tx, storageLocation, -weightKg, -originalCost);
        await InventoryService.updateBlackSeedInventory(tx, storageLocation, weightKg, originalCost);

        // 7. Post purchase ledger entry (Dr Inventory / Cr AP Suppliers + hamali)
        await LedgerService.postPurchaseVerification(tx, purchase.id);

        // 8. Mark PO completed (full flow done in one shot)
        await tx.purchaseOrder.update({
          where: { id: po.id },
          data: { status: 'COMPLETED' },
        });

        return { success: true as const, poNumber };
      });

      results.push(result);
    } catch (e: unknown) {
      results.push({ success: false, error: e instanceof Error ? e.message : 'Failed' });
    }
  }

  res.json({ results });
}
