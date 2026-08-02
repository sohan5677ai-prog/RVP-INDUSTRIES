import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { Prisma, type Party } from '@prisma/client';
import { HttpError } from '../lib/httpError.js';
import {
  createSaleOrderSchema,
  listSaleOrdersSchema,
  deliverSaleDispatchSchema,
  dispatchSaleOrderSchema,
  markPaidSchema,
  lorryReceiptSchema,
} from '../schemas/sale.schema.js';
import { InventoryService } from '../services/inventory.service.js';
import { computePappuOrderMargins } from './inventory.controller.js';
import { clearCache } from '../lib/cache.js';
import { LedgerService } from '../services/ledger.service.js';

import { calcSaleFreight, calcHamali, calcKataFee, pappuLoadingHamali, customLoadingHamali, productLoadingHamali, isVehicleExempt, seedBackedDispatchedKg } from '../lib/calc.js';
import {
  getFreightRateForDestination,
  getCompanyProfileRow,
  getHamaliRate,
  getHamaliRateFull,
  getCustomHamaliRates,
} from './settings.controller.js';
import { uploadFileToStorage } from '../lib/upload.js';
import { extractInvoiceData, type DocumentKind } from '../lib/gemini.js';
import { indianFinancialYear } from '../lib/invoice.js';
import { whatsappService } from '../services/whatsapp.service.js';

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
  const { status, product, skip, take, all } = listSaleOrdersSchema.parse(req.query);
  const isAll = all === 'true';
  const orders = await prisma.saleOrder.findMany({
    // The main listing is paginated (take 100). Aging reports bypass this by passing all=true.
    where: { ...(status ? { status } : {}), ...(product ? { product } : {}) },
    skip: isAll ? undefined : skip,
    take: isAll ? undefined : take,
    orderBy: { saleDate: 'desc' },
    include: {
      buyer: true,
      broker: true,
      dispatches: {
        orderBy: { dispatchDate: 'asc' },
        // Buyer receipts let the sales page show a shipment as Paid once
        // cleared (settledByDispatch sums amount + TDS + shortage).
        include: {
          receipts: {
            where: { type: 'BUYER' },
            select: { id: true, saleDispatchId: true, type: true, amount: true, tdsAmount: true, shortageAmount: true },
          },
        },
      },
    },
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

/** The dispatch shape the lorry-receipt endpoints return (drives the printed GC). */
const lorryReceiptInclude = { saleOrder: { include: { buyer: true, broker: true } } } as const;

/**
 * Next number in the GC book. The consignment note runs a single plain serial
 * (the book is not financial-year scoped), so the next one is simply the highest
 * issued number + 1. Hand-typed numbers that carry a prefix ("SRL-55") still
 * count - only their digits are read.
 */
async function nextGcNumber(tx: Prisma.TransactionClient): Promise<string> {
  const issued = await tx.saleDispatch.findMany({
    where: { lrNumber: { not: null } },
    select: { lrNumber: true },
  });
  const highest = issued.reduce((max, r) => {
    const digits = String(r.lrNumber).replace(/\D/g, '');
    const n = digits ? Number(digits) : 0;
    return n > max ? n : max;
  }, 0);
  return String(highest + 1);
}

/** Goods ship in 50 kg bags, so a lorry's packing follows from its weight. */
const DEFAULT_KG_PER_BAG = 50;

/**
 * Assign this shipment its GC number, if it has none. Idempotent - a receipt
 * that already carries a number (auto-assigned earlier, or typed off the
 * transporter's book) is returned untouched, so reprints never renumber. The GC
 * date defaults to the invoice date, falling back to the dispatch date, and the
 * packing to the dispatched weight in 50 kg bags (30 t = 600 bags).
 */
export async function assignLorryReceiptNumber(req: Request, res: Response) {
  const updated = await prisma.$transaction(async (tx) => {
    const dispatch = await tx.saleDispatch.findUnique({ where: { id: req.params.id } });
    if (!dispatch) throw new HttpError(404, 'Dispatch not found');
    if (dispatch.lrNumber) {
      return tx.saleDispatch.findUnique({ where: { id: dispatch.id }, include: lorryReceiptInclude });
    }
    const kgPerBag = dispatch.lrKgPerBag ?? DEFAULT_KG_PER_BAG;
    return tx.saleDispatch.update({
      where: { id: dispatch.id },
      data: {
        lrNumber: await nextGcNumber(tx),
        lrDate: dispatch.lrDate ?? dispatch.invoiceDate ?? dispatch.dispatchDate,
        lrKgPerBag: kgPerBag,
        lrBags: dispatch.lrBags ?? (kgPerBag > 0 ? Math.round(dispatch.weightKg / kgPerBag) : null),
      },
      include: lorryReceiptInclude,
    });
  });

  clearCache('sale-orders');
  res.json(updated);
}

/**
 * Save the Surya Road Lines lorry receipt (GC) details typed on the printable
 * copy. The GC number is assigned automatically (see assignLorryReceiptNumber)
 * but stays editable here, so a receipt written into the transporter's physical
 * book out of order can be corrected to match; persisting it keeps every reprint
 * identical to the copy that travelled with the lorry.
 */
export async function saveLorryReceipt(req: Request, res: Response) {
  const body = lorryReceiptSchema.parse(req.body);

  const dispatch = await prisma.saleDispatch.findUnique({ where: { id: req.params.id } });
  if (!dispatch) throw new HttpError(404, 'Dispatch not found');

  const updated = await prisma.saleDispatch.update({
    where: { id: req.params.id },
    data: {
      lrNumber: body.lrNumber?.trim() || null,
      lrDate: body.lrDate ? new Date(body.lrDate) : null,
      lrBags: body.lrBags ?? null,
      lrKgPerBag: body.lrKgPerBag ?? null,
    },
    include: lorryReceiptInclude,
  });

  clearCache('sale-orders');
  res.json(updated);
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

/**
 * The cost rates as they stand RIGHT NOW, pinned onto a new sale order.
 *
 * Freight used to be read live on every margin calculation, so editing a
 * destination's rate in Settings silently re-costed every order ever sold to
 * that destination. Stamping at creation makes a rate change apply only from
 * that order onwards - Surat 2800 -> 3000 leaves earlier orders at 2800, which
 * is the rate the delivered sale price was quoted against.
 */
async function currentCostStamps(destination: string | null) {
  return { freightRatePerTonne: await getFreightRateForDestination(destination) };
}

/**
 * Pin a fully-shipped Pappu order's seed cost to what actually backed it.
 *
 * From here the Pappu P&L reads this snapshot instead of re-running the
 * allocator, so a later stock-in, PO verification, bank-loan re-rate or Settings
 * edit can no longer move this order's margin.
 *
 * MUST run outside the dispatch/delivery transaction: the allocator reads
 * through `prisma` (not `tx`) and is memoised, so it has to see the committed
 * row. Clearing the cache first is what makes it recompute with the new lorry
 * counted. Idempotent - already-frozen orders are left alone, so calling it
 * again (from delivery, or a re-run of the backfill) is safe.
 */
async function freezeOrderCost(orderId: string) {
  const so = await prisma.saleOrder.findUnique({
    where: { id: orderId },
    select: { product: true, costFrozenAt: true },
  });
  if (!so || so.product !== 'PAPPU' || so.costFrozenAt != null) return;

  clearCache('pappu_order_margins');
  const m = (await computePappuOrderMargins()).find((x) => x.orderId === orderId);
  if (!m) return;

  await prisma.saleOrder.update({
    where: { id: orderId },
    data: {
      seedCostSnapshot: { seedBands: m.seedBands, seedKg: m.seedKg, seedCost: m.seedCost },
      costFrozenAt: new Date(),
    },
  });
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
  const stamps = await currentCostStamps(destination ?? buyer.destination ?? null);

  const order = await prisma.saleOrder.create({
    data: {
      saleDate: data.saleDate,
      product: data.product,
      buyerId: data.buyerId,
      brokerId: data.brokerId ?? null,
      tonnageKg: data.tonnageKg,
      ratePerKg: data.ratePerKg,
      dueDays: data.dueDays ?? null,
      reminderDate: data.reminderDate ?? null,
      gstAmount: data.gstExempt ? 0 : calcGst(data.tonnageKg, Number(data.ratePerKg), gstFraction),
      gstExempt: data.gstExempt || false,
      brokerageRatePerKg: data.brokerageRatePerKg,
      destination,
      freightCharge,
      marginOverride: data.marginOverride || false,
      ...stamps,
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
      gstExempt?: boolean;
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
        gstExempt: row.gstExempt ?? false,
        marginOverride: row.marginOverride ?? false,
        brokerageRatePerKg: 0,
      });

      const buyer = await prisma.party.findUnique({ where: { id: data.buyerId } });
      if (!buyer) throw new Error('Buyer not found');

      await assertPappuMargin(data.product, Number(data.ratePerKg), data.marginOverride);

      const { destination, freightCharge } = await deriveDestinationFreight(buyer, data.tonnageKg);
      const gstFraction = await gstFractionForProduct(data.product);
      const stamps = await currentCostStamps(destination ?? buyer.destination ?? null);

      const order = await prisma.saleOrder.create({
        data: {
          saleDate: data.saleDate,
          product: data.product,
          buyerId: data.buyerId,
          tonnageKg: data.tonnageKg,
          ratePerKg: data.ratePerKg,
          dueDays: data.dueDays ?? null,
          gstAmount: data.gstExempt ? 0 : calcGst(data.tonnageKg, Number(data.ratePerKg), gstFraction),
          gstExempt: data.gstExempt || false,
          brokerageRatePerKg: 0,
          destination,
          freightCharge,
          marginOverride: data.marginOverride || false,
          ...stamps,
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
      reminderDate: data.reminderDate ?? null,
      gstAmount: data.gstExempt ? 0 : calcGst(data.tonnageKg, Number(data.ratePerKg), gstFraction),
      gstExempt: data.gstExempt || false,
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

  // ── XS Pappu gate ──────────────────────────────────────────────────────────
  // Available pappu is DERIVED (remaining black seed × 60%), never counted. When
  // the mill out-turns better than 60% the surplus is real but invisible here,
  // so an order can be physically dispatchable while the engine shows nothing
  // backing it. Rather than blocking on a number we know is an assumption, we
  // surface it and let the user assert excess-out explicitly.
  //
  // Without that assertion the tonnage stays in the allocation backlog and will
  // consume the next black seed to arrive at RVP - seed it does not need, since
  // the surplus was already paid for over the assumed 60%.
  // Only the tonnage BEYOND what seed actually backs needs declaring - a 25 t
  // lorry against a 30 t order that is 4 t short must still go out unchallenged.
  // A part-backed lorry declares only its surplus portion (30 t out against
  // 20 t of seed = 10 t XS), so the backed 20 t keeps drawing seed normally.
  let excessOutKg = 0;
  if (order.product === 'PAPPU') {
    const m = (await computePappuOrderMargins()).find((x) => x.orderId === order.id);
    const unbackedKg = m?.unbackedPappuKg ?? 0;
    if (unbackedKg > 0) {
      const backedKg = Math.max(0, (m?.committedPappuKg ?? order.tonnageKg) - unbackedKg);
      const headroomKg = Math.max(0, backedKg - seedBackedDispatchedKg(order.dispatches));
      const shortfallKg = Math.max(0, weightKg - headroomKg);
      if (shortfallKg > 0 && data.excessOutKg < shortfallKg) {
        throw new HttpError(
          400,
          `Only ${(headroomKg / 1000).toFixed(2)} t of this order has black seed behind it - ` +
            `this lorry is ${(weightKg / 1000).toFixed(2)} t. If the balance is going out of yield ` +
            `surplus, declare at least ${(shortfallKg / 1000).toFixed(2)} t as XS Pappu (excess out).`,
        );
      }
    }
    excessOutKg = Math.min(data.excessOutKg, weightKg); // never more excess than the lorry weighs
  }
  let internalWeightKg = data.internalWeightKg ?? null;
  if (!internalWeightKg && order.product === 'PAPPU') {
    if (weightKg >= 35000) internalWeightKg = weightKg - 250;
    else if (weightKg >= 30000) internalWeightKg = weightKg - 200;
    else if (weightKg >= 25000) internalWeightKg = weightKg - 150;
    else if (weightKg >= 15000) internalWeightKg = weightKg - 50;
    else internalWeightKg = weightKg;
  }
  const baseAmount = weightKg * Number(order.ratePerKg);
  const gstAmount = order.gstExempt ? 0 : calcGst(weightKg, Number(order.ratePerKg), await gstFractionForProduct(order.product));
  const { freightCharge } = await deriveDestinationFreight(order.buyer, weightKg);

  // Lorry freight split (paid by us): destination unloading hamali + kata are
  // auto-computed from the standard rates, a fixed retention is held back until
  // delivery (released to Surya Roadlines at REACHED), and the remainder is the
  // lorry owner's. Only when there is freight to split.
  const company = await getCompanyProfileRow();
  const transportProvider = data.transportProvider ?? 'SURYA';
  const isCompanyVehicle = transportProvider === 'KNM';
  const retentionConfig = Number(company.freightRetentionPerTrip ?? 3000);
  const hasFreight = freightCharge > 0;
  const freightKata = calcKataFee(weightKg, isCompanyVehicle);
  let freightRetention = 0;
  if (hasFreight && !isCompanyVehicle) {
    if (transportProvider === 'SURYA') {
      freightRetention = retentionConfig;
    } else if (transportProvider === 'OTHER') {
      freightRetention = data.customRetention != null ? Number(data.customRetention) : 0;
    }
  }

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

  // Fully dispatched once this lorry takes the remaining balance to (or below) zero.
  const fullyDispatched = alreadyDispatchedKg + weightKg >= order.tonnageKg;

  // Upload before the transaction starts - network I/O shouldn't hold a DB
  // transaction open.
  const kataFileUrl = kataFile ? await uploadFileToStorage(kataFile) : null;

  const dispatch = await prisma.$transaction(async (tx) => {
    let cogsAmount = 0;
    const cogsInventoryAccount: string | undefined = undefined;
    const cogsCostCenter: string | undefined = undefined;
    if (order.product === 'PAPPU') {
      // XS tonnage relieves NO inventory: its seed was already fully expensed
      // over the assumed 60% out-turn, so relieving it again would book COGS for
      // seed that is not in the silo and put the GL at odds with the zero seed
      // cost the Pappu P&L reports for the same tonnage.
      cogsAmount = await InventoryService.consumeBlackSeedForSale(tx, weightKg - excessOutKg);
    }
    // Shell, Waste and the pre-cleaner byproducts carry no COGS silo relief - they
    // are revenue-only sales that draw down the shared 10% pool (tracked as a
    // derived figure, not a valued inventory).

    const created = await tx.saleDispatch.create({
      data: {
        saleOrderId: order.id,
        weightKg,
        internalWeightKg,
        ...(data.dispatchDate ? { dispatchDate: data.dispatchDate } : {}),
        gstAmount,
        freightCharge,
        status: 'DISPATCHED',
        vehicleNumber: data.vehicleNumber ?? null,
        driverName: data.driverName ?? null,
        driverPhone: data.driverPhone ?? null,
        kataFileUrl,
        transportProvider,
        customRetention: transportProvider === 'OTHER' ? (data.customRetention ?? null) : null,
        excessOutKg,
        excessOutNote: excessOutKg > 0 ? (data.excessOutNote ?? null) : null,
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

  if (order.product === 'PAPPU' && fullyDispatched) await freezeOrderCost(order.id);

  // WhatsApp the driver the buyer's name/phone/maps link - fire-and-forget,
  // only when a driver phone was captured on this dispatch. The broker/buyer
  // invoice bundle is sent later, from the explicit "Send via WhatsApp" action
  // (the invoice/EWB don't exist yet at dispatch time).
  void whatsappService.notifyDispatchDriver(
    { id: dispatch.id, vehicleNumber: dispatch.vehicleNumber, driverPhone: dispatch.driverPhone },
    { name: order.buyer.name, phone: order.buyer.phone, locationLink: order.buyer.locationLink }
  );

  res.status(201).json(dispatch);
}

/**
 * Undo a dispatch made by mistake. Allowed while the shipment is DISPATCHED or
 * DELIVERED (delivery posts nothing new), but blocked once a payment, E-Invoice
 * (IRN), or E-Way Bill exists against it - those must be reversed first. The
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

  // Delivery adds no inventory/GL postings of its own (those happened at dispatch),
  // so a delivered shipment can still be undone cleanly - unless a payment has been
  // recorded against it, in which case the receipt must be reversed first.
  const receiptCount = await prisma.receipt.count({ where: { saleDispatchId: dispatch.id } });
  if (receiptCount > 0) {
    throw new HttpError(400, 'A payment has been recorded against this shipment - reverse the receipt before undoing.');
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
      // Mirror the dispatch: XS tonnage relieved no inventory, so it restores none.
      await InventoryService.restoreBlackSeedForSale(
        tx,
        dispatch.weightKg - dispatch.excessOutKg,
        invCreditAmount,
      );
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
    // Undoing re-opens the order, so its frozen seed cost no longer describes
    // what shipped. Clear the freeze and let it go back to being computed live;
    // it re-freezes when the order is fully dispatched again.
    const reopened = status !== 'DISPATCHED';
    await tx.saleOrder.update({
      where: { id: order.id },
      data: {
        status,
        ...(reopened ? { seedCostSnapshot: Prisma.DbNull, costFrozenAt: null } : {}),
      },
    });
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

  // Un-Registered Sales get their own "URS" numbering pool, kept separate from the
  // regular registered "RVP" tax-invoice sequence.
  const unregistered = req.body?.unregistered === true;
  const series = unregistered ? 'URS' : 'RVP';

  const company = await getCompanyProfileRow();
  const prefix = unregistered ? 'URS' : (company.invoicePrefix || 'RVP');
  const invoiceDate = new Date();
  const fy = indianFinancialYear(invoiceDate);

  const updated = await prisma.$transaction(async (tx) => {
    // Next sequence within this financial year, scoped to this series so RVP and
    // URS each run their own 01, 02, 03… independently.
    const last = await tx.saleDispatch.aggregate({
      where: { invoiceFy: fy, invoiceSeries: series },
      _max: { invoiceSeq: true },
    });
    const seq = (last._max.invoiceSeq ?? 0) + 1;
    // Displayed number uses the short financial-year form (e.g. "26-27"), while
    // invoiceFy keeps the full "2026-27" used for the sequence + unique key.
    const fyShort = fy.slice(2);
    const invoiceNumber = `${prefix}/${String(seq).padStart(2, '0')}/${fyShort}`;

    return tx.saleDispatch.update({
      where: { id: dispatch.id },
      data: { invoiceSeq: seq, invoiceFy: fy, invoiceSeries: series, invoiceDate, invoiceNumber },
      include: { saleOrder: { include: { buyer: true, broker: true } } },
    });
  });

  res.json(updated);
}

/**
 * Peek at the invoice number this shipment WOULD get, without consuming it - used
 * by the Tally-style preview shown before the invoice is actually raised. Nothing
 * is written, so two people previewing at once both see the same next number; the
 * real number is only fixed when raiseSaleInvoice runs.
 */
export async function previewSaleInvoiceNumber(req: Request, res: Response) {
  const dispatch = await prisma.saleDispatch.findUnique({ where: { id: req.params.id } });
  if (!dispatch) throw new HttpError(404, 'Dispatch not found');

  // Already raised - the preview is simply the real thing.
  if (dispatch.invoiceNumber) {
    return res.json({
      invoiceNumber: dispatch.invoiceNumber,
      invoiceDate: dispatch.invoiceDate,
      series: dispatch.invoiceSeries ?? 'RVP',
      raised: true,
    });
  }

  const unregistered = req.query.unregistered === 'true' || req.query.unregistered === '1';
  const series = unregistered ? 'URS' : 'RVP';

  const company = await getCompanyProfileRow();
  const prefix = unregistered ? 'URS' : (company.invoicePrefix || 'RVP');
  const invoiceDate = new Date();
  const fy = indianFinancialYear(invoiceDate);

  const last = await prisma.saleDispatch.aggregate({
    where: { invoiceFy: fy, invoiceSeries: series },
    _max: { invoiceSeq: true },
  });
  const seq = (last._max.invoiceSeq ?? 0) + 1;
  const invoiceNumber = `${prefix}/${String(seq).padStart(2, '0')}/${fy.slice(2)}`;

  res.json({ invoiceNumber, invoiceDate, series, raised: false });
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
  if (dispatch.status !== 'DISPATCHED' && dispatch.status !== 'DELIVERED') {
    throw new HttpError(400, `Cannot mark a ${dispatch.status} shipment as delivered`);
  }

  // Block editing delivery details once payment has been recorded against this shipment.
  if (dispatch.status === 'DELIVERED') {
    const receiptCount = await prisma.receipt.count({ where: { saleDispatchId: dispatch.id } });
    if (receiptCount > 0) {
      throw new HttpError(400, 'Cannot edit delivery - payment has already been recorded against this shipment.');
    }
  }

  const order = dispatch.saleOrder;
  const rate = Number(order.ratePerKg);
  let orderIsFullyShipped = false;

  let shortageKg: number | null = null;
  let creditNoteAmount: number | null = null;
  let internalWeightProfitAmount: number | null = null;
  let profitWeightKg = 0;

  if (data.buyerKataKg !== undefined) {
    if (data.buyerKataKg > dispatch.weightKg) {
      throw new HttpError(400, "Buyer's Kata weight cannot be greater than dispatched weight. Contact admin.");
    }
    shortageKg = dispatch.weightKg - data.buyerKataKg;
    creditNoteAmount = shortageKg > 0 ? shortageKg * rate + (order.gstExempt ? 0 : calcGst(shortageKg, rate, await gstFractionForProduct(order.product))) : 0;
    
    if (dispatch.internalWeightKg && order.product === 'PAPPU') {
      profitWeightKg = data.buyerKataKg - dispatch.internalWeightKg;
      if (profitWeightKg > 0) {
        internalWeightProfitAmount = profitWeightKg * rate;
      }
    }
  }

  // Upload before the transaction starts - network I/O shouldn't hold a DB
  // transaction open.
  const buyerKataFileUrl = kataFile ? await uploadFileToStorage(kataFile) : null;

  const updated = await prisma.$transaction(async (tx) => {
    // We intentionally do not post a Credit Note to the ledger here anymore.
    // The shortage is recorded on the dispatch, but A/R is maintained at the full billed amount.
    // Deductions will be handled at the time of Receipt if the party doesn't pay the full amount.

    // Internal Weight Profit is saved on the dispatch record and shown in the
    // Internal Weight Ledger report, but is no longer posted to the ledger.
    // The retained freight was already credited to Surya Roadlines at dispatch.

    const result = await tx.saleDispatch.update({
      where: { id: dispatch.id },
      data: {
        status: 'DELIVERED',
        receivedDate: dispatch.receivedDate ?? (data.deliveredDate ?? new Date()),
        deliveredDate: data.deliveredDate ?? new Date(),
        ...(data.buyerKataKg !== undefined && {
          buyerKataKg: data.buyerKataKg,
          shortageKg,
          creditNoteAmount,
          internalWeightProfitAmount,
        }),
        ...(kataFile && { buyerKataFileUrl }),
      },
      include: { saleOrder: { include: { buyer: true, broker: true } } },
    });

    // Roll the order status forward: once every shipment on a fully-dispatched
    // order is DELIVERED, the order itself is DELIVERED. Otherwise it stays
    // DISPATCHED (all shipped, some still in transit) or PARTIAL (remainder unshipped).
    const siblings = await tx.saleDispatch.findMany({ where: { saleOrderId: order.id } });
    const dispatchedKg = siblings.reduce((s, d) => s + d.weightKg, 0);
    const orderStatus = dispatchedKg < order.tonnageKg
      ? 'PARTIAL'
      : siblings.every((d) => d.status === 'DELIVERED') ? 'DELIVERED' : 'DISPATCHED';
    orderIsFullyShipped = orderStatus !== 'PARTIAL';
    await tx.saleOrder.update({ where: { id: order.id }, data: { status: orderStatus } });

    return result;
  });

  // Safety net. The freeze normally happens at full dispatch; this catches an
  // order that got there without one (a freeze that failed, or a row predating
  // the feature). Idempotent, so it is a no-op in the normal case.
  if (order.product === 'PAPPU' && orderIsFullyShipped) await freezeOrderCost(order.id);

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
          // Link the receipt to its shipment and record any buyer-side
          // deductions on it, so the dispatch reads as fully settled
          // (settledByDispatch sums amount + TDS + shortage) and flips to Paid.
          saleDispatchId: dispatch.id,
          tdsAmount: data.tdsAmount > 0 ? data.tdsAmount : null,
          shortageAmount: data.shortageAmount > 0 ? data.shortageAmount : null,
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
