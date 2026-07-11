import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import type { Party } from '@prisma/client';
import { HttpError } from '../lib/httpError.js';
import {
  createSaleOrderSchema,
  listSaleOrdersSchema,
  deliverSaleDispatchSchema,
  dispatchSaleOrderSchema,
  markPaidSchema,
} from '../schemas/sale.schema.js';
import { InventoryService } from '../services/inventory.service.js';
import { LedgerService } from '../services/ledger.service.js';

import { calcSaleFreight, calcHamali, calcKataFee, pappuLoadingHamali, customLoadingHamali, productLoadingHamali, isVehicleExempt } from '../lib/calc.js';
import {
  getFreightRateForDestination,
  getCompanyProfileRow,
  getHamaliRate,
  getHamaliRateFull,
  getCustomHamaliRates,
} from './settings.controller.js';
import { fileUrl } from '../lib/upload.js';
import { extractInvoiceData, type DocumentKind } from '../lib/gemini.js';
import { indianFinancialYear } from '../lib/invoice.js';

const GST_RATE = 0.05; // fallback IGST fraction (5%) when a commodity has no configured rate

/** GST on weight × rate at the given fraction (default 5%), rounded to paise. */
function calcGst(weightKg: number, ratePerKg: number, fraction: number = GST_RATE): number {
  return Math.round(weightKg * ratePerKg * fraction * 100) / 100;
}

/** GST fraction (e.g. 0.05) configured for a commodity in Settings; defaults to 5%. */
async function gstFractionForProduct(product: string): Promise<number> {
  const info = await prisma.productTaxInfo.findUnique({ where: { product: product as any } });
  const pct = info?.gstRate != null ? Number(info.gstRate) : 5;
  return pct / 100;
}

/** Destination + outward freight, derived from the buyer's party + Settings rate. */
async function deriveDestinationFreight(buyer: Party, weightKg: number) {
  const destination = buyer.destination ?? null;
  const rate = await getFreightRateForDestination(destination);
  return { destination, freightCharge: calcSaleFreight(weightKg, rate) };
}

/**
 * Attach computed fulfilment fields. `dispatchedKg` is the sum of all dispatch
 * weights; `remainingKg` is the still-to-ship balance against the ordered weight.
 */
function withFulfilment<T extends { tonnageKg: number; dispatches?: { weightKg: number }[] }>(order: T) {
  const dispatchedKg = (order.dispatches ?? []).reduce((s, d) => s + d.weightKg, 0);
  return { ...order, dispatchedKg, remainingKg: Math.max(0, order.tonnageKg - dispatchedKg) };
}

export async function listSaleOrders(req: Request, res: Response) {
  const { status, product } = listSaleOrdersSchema.parse(req.query);
  const orders = await prisma.saleOrder.findMany({
    where: { ...(status ? { status } : {}), ...(product ? { product } : {}) },
    orderBy: { saleDate: 'desc' },
    include: { buyer: true, broker: true, dispatches: { orderBy: { dispatchDate: 'asc' } } },
  });
  res.json(orders.map(withFulfilment));
}

export async function getSaleOrder(req: Request, res: Response) {
  const order = await prisma.saleOrder.findUnique({
    where: { id: req.params.id },
    include: { buyer: true, broker: true, dispatches: { orderBy: { dispatchDate: 'asc' } } },
  });
  if (!order) throw new HttpError(404, 'Sale order not found');
  res.json(withFulfilment(order));
}

/** Fetch a single dispatch (with its order + buyer + broker) for the invoice view. */
export async function getSaleDispatch(req: Request, res: Response) {
  const dispatch = await prisma.saleDispatch.findUnique({
    where: { id: req.params.id },
    include: { saleOrder: { include: { buyer: true, broker: true } } },
  });
  if (!dispatch) throw new HttpError(404, 'Dispatch not found');
  res.json(dispatch);
}

/**
 * The 3% margin requirement only applies to Pappu (whose cost is derived from the
 * black-seed pool). Husk/Waste/TPS carry no black-seed cost, so no margin check.
 */
async function assertPappuMargin(product: string, ratePerKg: number, marginOverride: boolean) {
  if (product !== 'PAPPU') return;
  const pappuCost = await InventoryService.getBlackSeedPappuCostPerKg();
  const minRateRequired = pappuCost * 1.03;
  if (pappuCost > 0 && ratePerKg < minRateRequired && !marginOverride) {
    throw new HttpError(
      403,
      `Selling price (₹${ratePerKg.toFixed(2)}/kg) is below the minimum 3% profit margin over the live pappu cost (₹${pappuCost.toFixed(2)}/kg, black-seed cost ÷ 60%). Minimum: ₹${minRateRequired.toFixed(2)}/kg. Admin override required.`
    );
  }
}

export async function createSaleOrder(req: Request, res: Response) {
  const data = createSaleOrderSchema.parse(req.body);

  const buyer = await prisma.party.findUnique({ where: { id: data.buyerId } });
  if (!buyer) throw new HttpError(400, 'Buyer not found');
  if (buyer.type === 'SUPPLIER') throw new HttpError(400, 'Selected party is a supplier, not a buyer');

  if (data.brokerId) {
    const broker = await prisma.broker.findUnique({ where: { id: data.brokerId } });
    if (!broker) throw new HttpError(400, 'Broker not found');
  }

  await assertPappuMargin(data.product, Number(data.ratePerKg), data.marginOverride);



  const { destination, freightCharge } = await deriveDestinationFreight(buyer, data.tonnageKg);
  const gstFraction = await gstFractionForProduct(data.product);

  const order = await prisma.saleOrder.create({
    data: {
      saleDate: data.saleDate,
      product: data.product,
      buyerId: data.buyerId,
      brokerId: data.brokerId ?? null,
      tonnageKg: data.tonnageKg,
      ratePerKg: data.ratePerKg,
      dueDays: data.dueDays ?? null,
      gstAmount: calcGst(data.tonnageKg, Number(data.ratePerKg), gstFraction),
      brokerageRatePerKg: data.brokerageRatePerKg,
      destination,
      freightCharge,
      marginOverride: data.marginOverride || false,
    },
    include: { buyer: true, broker: true },
  });

  res.status(201).json(order);
}

export async function bulkCreateSaleOrders(req: Request, res: Response) {
  const { orders } = req.body as {
    orders: Array<{
      saleDate: string;
      buyerId: string;
      product?: string;
      tonnageKg: number;
      ratePerKg: number;
      dueDays?: number;
      marginOverride?: boolean;
    }>;
  };
  if (!Array.isArray(orders) || orders.length === 0) throw new HttpError(400, 'orders array is required');

  const results: Array<{ index: number; success: boolean; id?: string; error?: string }> = [];

  for (let i = 0; i < orders.length; i++) {
    try {
      const row = orders[i];
      const data = createSaleOrderSchema.parse({
        saleDate: row.saleDate,
        product: row.product ?? 'PAPPU',
        buyerId: row.buyerId,
        tonnageKg: row.tonnageKg,
        ratePerKg: row.ratePerKg,
        dueDays: row.dueDays,
        marginOverride: row.marginOverride ?? false,
        brokerageRatePerKg: 0,
      });

      const buyer = await prisma.party.findUnique({ where: { id: data.buyerId } });
      if (!buyer) throw new Error('Buyer not found');

      await assertPappuMargin(data.product, Number(data.ratePerKg), data.marginOverride);

      const { destination, freightCharge } = await deriveDestinationFreight(buyer, data.tonnageKg);
      const gstFraction = await gstFractionForProduct(data.product);

      const order = await prisma.saleOrder.create({
        data: {
          saleDate: data.saleDate,
          product: data.product,
          buyerId: data.buyerId,
          tonnageKg: data.tonnageKg,
          ratePerKg: data.ratePerKg,
          dueDays: data.dueDays ?? null,
          gstAmount: calcGst(data.tonnageKg, Number(data.ratePerKg), gstFraction),
          brokerageRatePerKg: 0,
          destination,
          freightCharge,
          marginOverride: data.marginOverride || false,
        },
      });



      results.push({ index: i, success: true, id: order.id });
    } catch (err: unknown) {
      results.push({ index: i, success: false, error: err instanceof Error ? err.message : 'Unknown error' });
    }
  }

  res.json({ results });
}

export async function updateSaleOrder(req: Request, res: Response) {
  const data = createSaleOrderSchema.parse(req.body);
  const order = await prisma.saleOrder.findUnique({ 
    where: { id: req.params.id },
    include: { dispatches: true }
  });
  if (!order) throw new HttpError(404, 'Sale order not found');

  const buyer = await prisma.party.findUnique({ where: { id: data.buyerId } });
  if (!buyer) throw new HttpError(400, 'Buyer not found');

  await assertPappuMargin(data.product, Number(data.ratePerKg), data.marginOverride);
  const { destination, freightCharge } = await deriveDestinationFreight(buyer, data.tonnageKg);
  const gstFraction = await gstFractionForProduct(data.product);

  const dispatchedKg = order.dispatches.reduce((s, d) => s + d.weightKg, 0);
  const status = dispatchedKg === 0 ? 'PENDING' : (dispatchedKg >= data.tonnageKg ? 'DISPATCHED' : 'PARTIAL');

  const updated = await prisma.saleOrder.update({
    where: { id: req.params.id },
    data: {
      saleDate: data.saleDate,
      product: data.product,
      buyerId: data.buyerId,
      brokerId: data.brokerId ?? null,
      tonnageKg: data.tonnageKg,
      ratePerKg: data.ratePerKg,
      dueDays: data.dueDays ?? null,
      gstAmount: calcGst(data.tonnageKg, Number(data.ratePerKg), gstFraction),
      brokerageRatePerKg: data.brokerageRatePerKg,
      destination,
      freightCharge,
      marginOverride: data.marginOverride || false,
      status,
    },
    include: { buyer: true, broker: true },
  });

  res.json(updated);
}

export async function deleteSaleOrder(req: Request, res: Response) {
  const order = await prisma.saleOrder.findUnique({ where: { id: req.params.id } });
  if (!order) throw new HttpError(404, 'Sale order not found');
  if (order.status !== 'PENDING') {
    throw new HttpError(400, 'Cannot delete a sale order that has dispatches. Please undo all dispatches first.');
  }
  await prisma.saleOrder.delete({ where: { id: req.params.id } });
  res.json({ message: 'Sale order deleted' });
}

/**
 * Read a sale's invoice or kata slip and return the fields it can extract, so the
 * dispatch dialog can pre-fill. Does not persist - the file is held in memory.
 */
export async function extractSaleDoc(req: Request, res: Response) {
  if (!req.file) throw new HttpError(400, 'Document file is required');
  const kind = (req.body?.kind as string) ?? 'invoice';
  // The kata slip reuses the weighbridge-net prompt ('partyKata').
  const geminiKind: DocumentKind = kind === 'kata' ? 'partyKata' : 'invoice';

  const data = await extractInvoiceData(req.file.buffer, req.file.mimetype, geminiKind);

  res.json({
    invoiceNumber: data.invoiceNumber ?? null,
    vehicleNumber: data.lorryNumber ?? null,
    // Invoice billed weight or kata net weight, whichever the doc yielded.
    tonnageKg: data.partyKataKg ?? data.billingWeightKg ?? null,
  });
}

/**
 * Dispatch a (partial) quantity of a sale order: store the uploaded kata slip,
 * record the confirmed vehicle no / kata tonnage as one SaleDispatch, then bill
 * (revenue + GST + freight) and - for Pappu - deplete the pool with COGS. The tax
 * invoice is raised per dispatch separately afterwards. The order's ordered weight
 * is never overwritten; its status moves PENDING/PARTIAL -> PARTIAL/DISPATCHED as
 * the remaining balance shrinks to zero.
 */
export async function dispatchSaleOrder(req: Request, res: Response) {
  const data = dispatchSaleOrderSchema.parse(req.body);
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  const kataFile = files?.kata?.[0];

  const order = await prisma.saleOrder.findUnique({
    where: { id: req.params.id },
    include: { buyer: true, dispatches: true },
  });
  if (!order) throw new HttpError(404, 'Sale order not found');
  if (order.status === 'DISPATCHED') throw new HttpError(400, 'Sale order is already fully dispatched');

  const alreadyDispatchedKg = order.dispatches.reduce((s, d) => s + d.weightKg, 0);
  const weightKg = data.tonnageKg;
  let internalWeightKg = data.internalWeightKg ?? null;
  if (!internalWeightKg && order.product === 'PAPPU') {
    if (weightKg >= 35000) internalWeightKg = weightKg - 250;
    else if (weightKg >= 30000) internalWeightKg = weightKg - 200;
    else if (weightKg >= 25000) internalWeightKg = weightKg - 150;
    else if (weightKg >= 15000) internalWeightKg = weightKg - 50;
    else internalWeightKg = weightKg;
  }
  const baseAmount = weightKg * Number(order.ratePerKg);
  const gstAmount = calcGst(weightKg, Number(order.ratePerKg), await gstFractionForProduct(order.product));
  const { freightCharge } = await deriveDestinationFreight(order.buyer, weightKg);

  // Lorry freight split (paid by us): destination unloading hamali + kata are
  // auto-computed from the standard rates, a fixed retention is held back until
  // delivery (released to Surya Roadlines at REACHED), and the remainder is the
  // lorry owner's. Only when there is freight to split.
  const company = await getCompanyProfileRow();
  const isCompanyVehicle = isVehicleExempt(data.vehicleNumber, company.companyVehicles);
  const retentionConfig = Number(company.freightRetentionPerTrip ?? 3000);
  const hasFreight = freightCharge > 0;
  const freightKata = calcKataFee(weightKg, isCompanyVehicle);
  const freightRetention = (hasFreight && !isCompanyVehicle) ? retentionConfig : 0;

  // Loading hamali split (all rates editable in Settings → Hamali Rates):
  //   - Pappu: ₹220/t - lorry funds ₹80/t (off its freight), we bear the rest,
  //     crew paid ₹210/t, ₹10/t company P/L.
  //   - Husk / Waste: 100% company-borne byproduct loading (buyer usually lifts
  //     ex-works), applied at every dispatch regardless of whether we carry freight.
  //   - TPS: ₹160/t off the lorry's freight (no company share or margin).
  //   - Shell: flat default rate off the lorry's freight.
  let freightUnloadingHamali = 0; // hamali amount deducted off the lorry's freight
  let hamaliCrewPayable = 0; // total hamali paid to the crew
  let hamaliCompanyExpense = 0; // our company-borne loading-hamali cost
  let hamaliMargin = 0; // company hamali profit → P/L
  // Waste and the three pre-cleaner byproducts (Pre Cleaner Dust, Nalla Pokkulu,
  // Nalla Chintapandu) all share the Tamarind Waste loading rate.
  const isPoolByproduct =
    order.product === 'WASTE' ||
    order.product === 'PRECLEANER_DUST' ||
    order.product === 'NALLA_POKKULU' ||
    order.product === 'NALLA_CHINTAPANDU';
  if (order.product === 'HUSK' || isPoolByproduct) {
    const rateKey = order.product === 'HUSK' ? 'HUSK_LOADING' : 'WASTE_LOADING';
    const pl = await getHamaliRateFull(rateKey);
    const lh = customLoadingHamali(weightKg, pl.total, pl.lorry, pl.margin, isCompanyVehicle);
    
    if (hasFreight) {
      freightUnloadingHamali = lh.lorry;
      hamaliCrewPayable = lh.crew;
      hamaliCompanyExpense = lh.company;
      hamaliMargin = lh.margin;
    } else {
      hamaliCompanyExpense = lh.company;
      hamaliCrewPayable = lh.company;
    }
  } else if (order.product === 'PAPPU') {
    const pl = await getHamaliRateFull('PAPPU_LOADING');
    const lh = pappuLoadingHamali(weightKg, isCompanyVehicle, pl.total, pl.lorry, pl.margin);
    
    freightUnloadingHamali = lh.lorry;
    hamaliCrewPayable = lh.crew;
    hamaliCompanyExpense = lh.company;
    hamaliMargin = lh.margin;

    // Any user-added custom costs (e.g. Roasting) are charged on top of the standard Pappu loading
    for (const c of await getCustomHamaliRates()) {
      const ch = customLoadingHamali(weightKg, c.total, c.lorry, c.margin, isCompanyVehicle);
      freightUnloadingHamali += ch.lorry;
      hamaliCrewPayable += ch.crew;
      hamaliCompanyExpense += ch.company;
      hamaliMargin += ch.margin;
    }
  } else if (order.product === 'TPS' || order.product === 'SHELL') {
    // Both TPS & Shell defaults are identical: ₹160/t deducted off the lorry's freight
    // and paid fully to the crew (no company share or margin), so both use TPS_LOADING.
    const pl = await getHamaliRateFull('TPS_LOADING');
    const lh = customLoadingHamali(weightKg, pl.total, pl.lorry, pl.margin, isCompanyVehicle);
    
    if (hasFreight) {
      freightUnloadingHamali = lh.lorry;
      hamaliCrewPayable = lh.crew;
      hamaliCompanyExpense = lh.company;
      hamaliMargin = lh.margin;
    } else {
      // Typically these aren't sold without freight, but just in case:
      hamaliCompanyExpense = lh.company;
      hamaliCrewPayable = lh.company;
    }
  } else if (hasFreight) {
      freightUnloadingHamali = calcHamali(weightKg);
      hamaliCrewPayable = freightUnloadingHamali;
  }

  // Production cost (₹/kg components) is added to pappu COGS.
  const productionCostPerKg = await InventoryService.getProductionCostPerKg();
  const productionCostAmount =
    order.product === 'PAPPU' ? Math.round(weightKg * productionCostPerKg * 100) / 100 : 0;

  // Fully dispatched once this lorry takes the remaining balance to (or below) zero.
  const fullyDispatched = alreadyDispatchedKg + weightKg >= order.tonnageKg;

  const dispatch = await prisma.$transaction(async (tx) => {
    let cogsAmount = 0;
    const cogsInventoryAccount: string | undefined = undefined;
    const cogsCostCenter: string | undefined = undefined;
    if (order.product === 'PAPPU') {
      cogsAmount = await InventoryService.consumeBlackSeedForSale(tx, weightKg);
    }
    // Shell, Waste and the pre-cleaner byproducts carry no COGS silo relief - they
    // are revenue-only sales that draw down the shared 10% pool (tracked as a
    // derived figure, not a valued inventory).

    const created = await tx.saleDispatch.create({
      data: {
        saleOrderId: order.id,
        weightKg,
        internalWeightKg,
        gstAmount,
        freightCharge,
        status: 'DISPATCHED',
        vehicleNumber: data.vehicleNumber ?? null,
        kataFileUrl: kataFile ? fileUrl(kataFile.filename) : null,
      },
    });

    // Ledger is keyed per dispatch so each lorry posts its own sale.
    await LedgerService.postSale(tx, created.id, {
      buyerName: order.buyer.name,
      product: order.product,
      baseAmount,
      gstAmount,
      cogsAmount,
      cogsInventoryAccount,
      cogsCostCenter,
      productionCostAmount,
      freightAmount: freightCharge,
      freightUnloadingHamali,
      freightKata,
      freightRetention,
      hamaliCrewPayable,
      hamaliCompanyExpense,
      hamaliMargin,
      weightKg,
      isCompanyVehicle,
    });

    await tx.saleOrder.update({
      where: { id: order.id },
      data: { status: fullyDispatched ? 'DISPATCHED' : 'PARTIAL' },
    });

    return created;
  });

  res.status(201).json(dispatch);
}

/**
 * Undo a dispatch made by mistake. Only allowed while the shipment is still a
 * plain DISPATCHED record - once it is delivered, invoiced, or has an E-Invoice /
 * E-Way Bill against it, the undo is blocked (those must be reversed first). The
 * reversal: restores the inventory consumed at dispatch (black-seed pool for
 * pappu, shell store for shell), deletes the sale's ledger posting, removes the
 * SaleDispatch, and recomputes the order status from the remaining shipments.
 */
export async function undoSaleDispatch(req: Request, res: Response) {
  const dispatch = await prisma.saleDispatch.findUnique({
    where: { id: req.params.id },
    include: { saleOrder: true },
  });
  if (!dispatch) throw new HttpError(404, 'Dispatch not found');
  if (dispatch.status === 'DELIVERED') {
    throw new HttpError(400, 'Cannot undo a delivered shipment - reverse the delivery first.');
  }
  if (dispatch.invoiceNumber) {
    throw new HttpError(400, 'Cannot undo a dispatch once its tax invoice is raised.');
  }
  if (dispatch.irn && dispatch.irnStatus !== 'CANCELLED') {
    throw new HttpError(400, 'Cancel the E-Invoice (IRN) before undoing this dispatch.');
  }
  if (dispatch.ewbNumber && dispatch.ewbStatus !== 'CANCELLED') {
    throw new HttpError(400, 'Cancel the E-Way Bill before undoing this dispatch.');
  }

  const order = dispatch.saleOrder;

  await prisma.$transaction(async (tx) => {
    // 1. Restore the inventory relieved at dispatch, valued at the exact cost the
    //    sale's COGS posting recorded (read off the black-seed inventory credit
    //    line). Only Pappu draws down a valued pool; Shell/Waste/byproducts are
    //    revenue-only (they only touched the derived 10% pool), so nothing to restore.
    if (order.product === 'PAPPU') {
      const saleEntry = await tx.journalEntry.findFirst({
        where: { reference: `SALE-${dispatch.id}` },
        include: { lines: { include: { account: true } } },
      });
      const invCreditAmount = saleEntry
        ? saleEntry.lines
            .filter((l) => l.account.code === '10010')
            .reduce((s, l) => s + Number(l.credit), 0)
        : 0;
      await InventoryService.restoreBlackSeedForSale(tx, dispatch.weightKg, invCreditAmount);
    }

    // 2. Delete the sale's ledger posting (journal lines cascade with the entry).
    await tx.journalEntry.deleteMany({ where: { reference: `SALE-${dispatch.id}` } });

    // 3. Remove the dispatch itself.
    await tx.saleDispatch.delete({ where: { id: dispatch.id } });

    // 4. Recompute the order's status from whatever shipments remain.
    const remaining = await tx.saleDispatch.findMany({ where: { saleOrderId: order.id } });
    const dispatchedKg = remaining.reduce((s, d) => s + d.weightKg, 0);
    const status = dispatchedKg === 0
      ? 'PENDING'
      : dispatchedKg >= order.tonnageKg ? 'DISPATCHED' : 'PARTIAL';
    await tx.saleOrder.update({ where: { id: order.id }, data: { status } });
  });

  res.json({ message: 'Dispatch undone' });
}

/**
 * Raise the tax invoice for an already-dispatched shipment. Auto-assigns the next
 * invoice number (prefix/seq/FY, sequence resets each financial year) and stamps
 * the invoice date. The sale was already billed at dispatch, so no new ledger
 * entry is posted. Idempotent - re-raising keeps the existing number.
 */
export async function raiseSaleInvoice(req: Request, res: Response) {
  const dispatch = await prisma.saleDispatch.findUnique({
    where: { id: req.params.id },
    include: { saleOrder: { include: { buyer: true, broker: true } } },
  });
  if (!dispatch) throw new HttpError(404, 'Dispatch not found');
  if (dispatch.invoiceNumber) return res.json(dispatch);

  const company = await getCompanyProfileRow();
  const prefix = company.invoicePrefix || 'RVP';
  const invoiceDate = new Date();
  const fy = indianFinancialYear(invoiceDate);

  const updated = await prisma.$transaction(async (tx) => {
    // Next sequence within this financial year (across all dispatches).
    const last = await tx.saleDispatch.aggregate({
      where: { invoiceFy: fy },
      _max: { invoiceSeq: true },
    });
    const seq = (last._max.invoiceSeq ?? 0) + 1;
    const invoiceNumber = `${prefix}/${String(seq).padStart(2, '0')}/${fy}`;

    return tx.saleDispatch.update({
      where: { id: dispatch.id },
      data: { invoiceSeq: seq, invoiceFy: fy, invoiceDate, invoiceNumber },
      include: { saleOrder: { include: { buyer: true, broker: true } } },
    });
  });

  res.json(updated);
}

/**
 * Mark a dispatched shipment as delivered (DISPATCHED -> DELIVERED). Records the
 * deliveredDate (the payment-due-date anchor), captures the buyer's kata weight to
 * settle any shortage with a credit note, releases the freight retention held at
 * dispatch, and optionally stores the buyer's kata slip.
 */
export async function deliverSaleDispatch(req: Request, res: Response) {
  const data = deliverSaleDispatchSchema.parse(req.body);
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  const kataFile = files?.kata?.[0];

  const dispatch = await prisma.saleDispatch.findUnique({
    where: { id: req.params.id },
    include: { saleOrder: { include: { buyer: true } } },
  });
  if (!dispatch) throw new HttpError(404, 'Dispatch not found');
  if (dispatch.status !== 'DISPATCHED') {
    throw new HttpError(400, `Cannot mark a ${dispatch.status} shipment as delivered`);
  }

  const order = dispatch.saleOrder;
  const rate = Number(order.ratePerKg);

  let shortageKg: number | null = null;
  let creditNoteAmount: number | null = null;
  let internalWeightProfitAmount: number | null = null;
  let profitWeightKg = 0;

  if (data.buyerKataKg !== undefined) {
    if (data.buyerKataKg > dispatch.weightKg) {
      throw new HttpError(400, "Buyer's Kata weight cannot be greater than dispatched weight. Contact admin.");
    }
    shortageKg = dispatch.weightKg - data.buyerKataKg;
    creditNoteAmount = shortageKg > 0 ? shortageKg * rate + calcGst(shortageKg, rate, await gstFractionForProduct(order.product)) : 0;
    
    if (dispatch.internalWeightKg && order.product === 'PAPPU') {
      profitWeightKg = data.buyerKataKg - dispatch.internalWeightKg;
      if (profitWeightKg > 0) {
        internalWeightProfitAmount = profitWeightKg * rate;
      }
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    // We intentionally do not post a Credit Note to the ledger here anymore.
    // The shortage is recorded on the dispatch, but A/R is maintained at the full billed amount.
    // Deductions will be handled at the time of Receipt if the party doesn't pay the full amount.

    // Internal Weight Profit is saved on the dispatch record and shown in the
    // Internal Weight Ledger report, but is no longer posted to the ledger.
    // The retained freight was already credited to Surya Roadlines at dispatch.

    return tx.saleDispatch.update({
      where: { id: dispatch.id },
      data: {
        status: 'DELIVERED',
        receivedDate: dispatch.receivedDate ?? new Date(),
        deliveredDate: new Date(),
        ...(data.buyerKataKg !== undefined && {
          buyerKataKg: data.buyerKataKg,
          shortageKg,
          creditNoteAmount,
          internalWeightProfitAmount,
        }),
        ...(kataFile && { buyerKataFileUrl: fileUrl(kataFile.filename) }),
      },
      include: { saleOrder: { include: { buyer: true, broker: true } } },
    });
  });

  res.json(updated);
}

export async function markDispatchPaid(req: Request, res: Response) {
  const data = markPaidSchema.parse(req.body);
  const dispatch = await prisma.saleDispatch.findUnique({
    where: { id: req.params.id },
    include: { saleOrder: { include: { buyer: true } } },
  });
  if (!dispatch) throw new HttpError(404, 'Dispatch not found');

  const buyer = dispatch.saleOrder.buyer;

  const updated = await prisma.$transaction(async (tx) => {
    // 1. Create Receipt if amount > 0
    if (data.amount > 0) {
      const createdReceipt = await tx.receipt.create({
        data: {
          date: data.date,
          amount: data.amount,
          type: 'BUYER',
          partyId: buyer.id,
          description: `Payment for Invoice ${dispatch.invoiceNumber ?? dispatch.id}`,
        },
      });

      await LedgerService.postReceipt(tx, createdReceipt.id, {
        date: data.date,
        amount: data.amount,
        type: 'BUYER',
        partyName: buyer.name,
        description: `Payment for Invoice ${dispatch.invoiceNumber ?? dispatch.id}`,
      });

      const journalEntry = await tx.journalEntry.findFirst({
        where: { reference: `RECEIPT-${createdReceipt.id}` },
      });
      
      if (journalEntry) {
        await tx.receipt.update({
          where: { id: createdReceipt.id },
          data: { journalEntryId: journalEntry.id },
        });
      }
    }

    // 2. Post TDS Deduction if any
    if (data.tdsAmount > 0) {
      await LedgerService.postSaleTdsDeduction(tx, dispatch.id, {
        date: data.date,
        buyerName: buyer.name,
        tdsAmount: data.tdsAmount,
      });
    }

    // 3. Post Shortage Deduction if any
    if (data.shortageAmount > 0) {
      await LedgerService.postSaleShortageDeduction(tx, dispatch.id, {
        date: data.date,
        buyerName: buyer.name,
        shortageAmount: data.shortageAmount,
      });
    }

    // 4. Update dispatch with tdsAmount and creditNoteAmount (shortage)
    return tx.saleDispatch.update({
      where: { id: dispatch.id },
      data: {
        tdsAmount: data.tdsAmount,
        creditNoteAmount: data.shortageAmount > 0 ? data.shortageAmount : dispatch.creditNoteAmount,
      },
      include: { saleOrder: { include: { buyer: true, broker: true } } },
    });
  });

  res.json(updated);
}
