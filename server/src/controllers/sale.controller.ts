import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import type { Party } from '@prisma/client';
import { HttpError } from '../lib/httpError.js';
import {
  createSaleOrderSchema,
  listSaleOrdersSchema,
  advanceSaleStatusSchema,
  dispatchSaleOrderSchema,
} from '../schemas/sale.schema.js';
import { InventoryService } from '../services/inventory.service.js';
import { LedgerService } from '../services/ledger.service.js';
import { calcSaleFreight, calcHamali, calcKataFee, pappuLoadingHamali } from '../lib/calc.js';
import { getFreightRateForDestination, getCompanyProfileRow } from './settings.controller.js';
import { fileUrl } from '../lib/upload.js';
import { extractInvoiceData, type DocumentKind } from '../lib/gemini.js';
import { indianFinancialYear } from '../lib/invoice.js';

const GST_RATE = 0.05; // 5% IGST on the sale amount

/** GST (5% IGST) on weight × rate, rounded to paise. */
function calcGst(weightKg: number, ratePerKg: number): number {
  return Math.round(weightKg * ratePerKg * GST_RATE * 100) / 100;
}

/** Destination + outward freight, derived from the buyer's party + Settings rate. */
async function deriveDestinationFreight(buyer: Party, weightKg: number) {
  const destination = buyer.destination ?? null;
  const rate = await getFreightRateForDestination(destination);
  return { destination, freightCharge: calcSaleFreight(weightKg, rate) };
}

export async function listSaleOrders(req: Request, res: Response) {
  const { status, product } = listSaleOrdersSchema.parse(req.query);
  const orders = await prisma.saleOrder.findMany({
    where: { ...(status ? { status } : {}), ...(product ? { product } : {}) },
    orderBy: { saleDate: 'desc' },
    include: { buyer: true, broker: true },
  });
  res.json(orders);
}

export async function getSaleOrder(req: Request, res: Response) {
  const order = await prisma.saleOrder.findUnique({
    where: { id: req.params.id },
    include: { buyer: true, broker: true },
  });
  if (!order) throw new HttpError(404, 'Sale order not found');
  res.json(order);
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

  const order = await prisma.saleOrder.create({
    data: {
      saleDate: data.saleDate,
      product: data.product,
      buyerId: data.buyerId,
      brokerId: data.brokerId ?? null,
      tonnageKg: data.tonnageKg,
      ratePerKg: data.ratePerKg,
      dueDays: data.dueDays ?? null,
      gstAmount: calcGst(data.tonnageKg, Number(data.ratePerKg)),
      brokerageRatePerKg: data.brokerageRatePerKg,
      destination,
      freightCharge,
      marginOverride: data.marginOverride || false,
    },
    include: { buyer: true, broker: true },
  });
  res.status(201).json(order);
}

export async function updateSaleOrder(req: Request, res: Response) {
  const data = createSaleOrderSchema.parse(req.body);
  const order = await prisma.saleOrder.findUnique({ where: { id: req.params.id } });
  if (!order) throw new HttpError(404, 'Sale order not found');
  if (order.status !== 'PENDING') {
    throw new HttpError(400, 'Cannot edit a sale order that is already dispatched');
  }

  const buyer = await prisma.party.findUnique({ where: { id: data.buyerId } });
  if (!buyer) throw new HttpError(400, 'Buyer not found');

  await assertPappuMargin(data.product, Number(data.ratePerKg), data.marginOverride);
  const { destination, freightCharge } = await deriveDestinationFreight(buyer, data.tonnageKg);

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
      gstAmount: calcGst(data.tonnageKg, Number(data.ratePerKg)),
      brokerageRatePerKg: data.brokerageRatePerKg,
      destination,
      freightCharge,
      marginOverride: data.marginOverride || false,
    },
    include: { buyer: true, broker: true },
  });
  res.json(updated);
}

export async function deleteSaleOrder(req: Request, res: Response) {
  const order = await prisma.saleOrder.findUnique({ where: { id: req.params.id } });
  if (!order) throw new HttpError(404, 'Sale order not found');
  if (order.status !== 'PENDING') {
    throw new HttpError(400, 'Cannot delete a sale order that is already dispatched');
  }
  await prisma.saleOrder.delete({ where: { id: req.params.id } });
  res.json({ message: 'Sale order deleted' });
}

/**
 * Read a sale's invoice or kata slip and return the fields it can extract, so the
 * dispatch dialog can pre-fill. Does not persist — the file is held in memory.
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
 * Dispatch a sale order: store the uploaded kata slip, record the confirmed
 * vehicle no / kata tonnage, set that tonnage as the actual sold weight, then bill
 * (revenue + GST + freight) and — for Pappu — deplete the pool with COGS. The tax
 * invoice is raised separately afterwards. PENDING -> DISPATCHED.
 */
export async function dispatchSaleOrder(req: Request, res: Response) {
  const data = dispatchSaleOrderSchema.parse(req.body);
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  const kataFile = files?.kata?.[0];

  const order = await prisma.saleOrder.findUnique({
    where: { id: req.params.id },
    include: { buyer: true },
  });
  if (!order) throw new HttpError(404, 'Sale order not found');
  if (order.status !== 'PENDING') throw new HttpError(400, 'Sale order is not pending dispatch');

  const weightKg = data.tonnageKg;
  const baseAmount = weightKg * Number(order.ratePerKg);
  const gstAmount = calcGst(weightKg, Number(order.ratePerKg));
  const { freightCharge } = await deriveDestinationFreight(order.buyer, weightKg);

  // Lorry freight split (paid by us): destination unloading hamali + kata are
  // auto-computed from the standard rates, a fixed retention is held back until
  // delivery (released to Surya Roadlines at REACHED), and the remainder is the
  // lorry owner's. Only when there is freight to split.
  const company = await getCompanyProfileRow();
  const retentionConfig = Number(company.freightRetentionPerTrip ?? 3000);
  const hasFreight = freightCharge > 0;
  const freightKata = hasFreight ? calcKataFee(weightKg) : 0;
  const freightRetention = hasFreight ? retentionConfig : 0;

  // Loading hamali split. Pappu uses the ₹220/t loading rate: the lorry funds
  // ₹80/t (deducted off its freight), we bear ₹140/t, the crew is paid ₹210/t
  // and ₹10/t is company P/L. Other products keep the flat ₹160/t (fully off the
  // lorry's freight, no company share or margin).
  let freightUnloadingHamali = 0; // hamali amount deducted off the lorry's freight
  let hamaliCrewPayable = 0; // total hamali paid to the crew
  let hamaliCompanyExpense = 0; // our company-borne loading-hamali cost
  let hamaliMargin = 0; // company hamali profit → P/L
  if (hasFreight) {
    if (order.product === 'PAPPU') {
      const lh = pappuLoadingHamali(weightKg);
      freightUnloadingHamali = lh.lorry;
      hamaliCrewPayable = lh.crew;
      hamaliCompanyExpense = lh.company;
      hamaliMargin = lh.margin;
    } else {
      freightUnloadingHamali = calcHamali(weightKg);
      hamaliCrewPayable = freightUnloadingHamali;
    }
  }

  // Production cost (₹/kg components) is added to pappu COGS.
  const productionCostPerKg = await InventoryService.getProductionCostPerKg();
  const productionCostAmount =
    order.product === 'PAPPU' ? Math.round(weightKg * productionCostPerKg * 100) / 100 : 0;

  const updated = await prisma.$transaction(async (tx) => {
    let cogsAmount = 0;
    let cogsInventoryAccount: string | undefined;
    let cogsCostCenter: string | undefined;
    if (order.product === 'PAPPU') {
      cogsAmount = await InventoryService.consumeBlackSeedForSale(tx, weightKg);
    } else if (order.product === 'SHELL') {
      // Shell is sold from the Rampalli storage it was transferred to.
      cogsAmount = await InventoryService.consumeShellInventory(tx, 'Rampalli', weightKg);
      cogsInventoryAccount = '10060'; // Tamarind Shell Inventory
      cogsCostCenter = 'Rampalli';
    }

    await LedgerService.postSale(tx, order.id, {
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
      brokerageAmount: order.brokerId ? 2000 : 0,
    });

    return tx.saleOrder.update({
      where: { id: order.id },
      data: {
        status: 'DISPATCHED',
        tonnageKg: weightKg,
        gstAmount,
        freightCharge,
        vehicleNumber: data.vehicleNumber ?? null,
        kataFileUrl: kataFile ? fileUrl(kataFile.filename) : order.kataFileUrl,
      },
      include: { buyer: true, broker: true },
    });
  });

  res.json(updated);
}

/**
 * Raise the tax invoice for an already-dispatched order. Auto-assigns the next
 * invoice number (prefix/seq/FY, sequence resets each financial year) and stamps
 * the invoice date. The sale was already billed at dispatch, so no new ledger
 * entry is posted. Idempotent — re-raising keeps the existing number.
 */
export async function raiseSaleInvoice(req: Request, res: Response) {
  const order = await prisma.saleOrder.findUnique({ where: { id: req.params.id } });
  if (!order) throw new HttpError(404, 'Sale order not found');
  if (order.status === 'PENDING') {
    throw new HttpError(400, 'Dispatch the order before raising its invoice');
  }
  if (order.invoiceNumber) {
    const existing = await prisma.saleOrder.findUnique({
      where: { id: order.id },
      include: { buyer: true, broker: true },
    });
    return res.json(existing);
  }

  const company = await getCompanyProfileRow();
  const prefix = company.invoicePrefix || 'RVP';
  const invoiceDate = new Date();
  const fy = indianFinancialYear(invoiceDate);

  const updated = await prisma.$transaction(async (tx) => {
    // Next sequence within this financial year.
    const last = await tx.saleOrder.aggregate({
      where: { invoiceFy: fy },
      _max: { invoiceSeq: true },
    });
    const seq = (last._max.invoiceSeq ?? 0) + 1;
    const invoiceNumber = `${prefix}/${String(seq).padStart(2, '0')}/${fy}`;

    return tx.saleOrder.update({
      where: { id: order.id },
      data: { invoiceSeq: seq, invoiceFy: fy, invoiceDate, invoiceNumber },
      include: { buyer: true, broker: true },
    });
  });

  res.json(updated);
}


/**
 * Mark a dispatched order as reached (DISPATCHED -> REACHED). The transition is
 * fixed, so we don't take a status from the client — we just record the buyer's
 * kata weight to settle any shortage with a credit note.
 */
export async function advanceSaleStatus(req: Request, res: Response) {
  const data = advanceSaleStatusSchema.parse(req.body);
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  const kataFile = files?.kata?.[0];

  const order = await prisma.saleOrder.findUnique({
    where: { id: req.params.id },
    include: { buyer: true }
  });
  if (!order) throw new HttpError(404, 'Sale order not found');

  if (order.status !== 'DISPATCHED') {
    throw new HttpError(400, `Cannot mark a ${order.status} order as reached`);
  }

  let shortageKg: number | null = null;
  let creditNoteAmount: number | null = null;

  if (data.buyerKataKg !== undefined) {
    if (data.buyerKataKg > order.tonnageKg) {
      throw new HttpError(400, "Buyer's Kata weight cannot be greater than dispatched weight. Contact admin.");
    }
    if (data.buyerKataKg < order.tonnageKg) {
      shortageKg = order.tonnageKg - data.buyerKataKg;
      const rate = Number(order.ratePerKg);
      const baseAmount = shortageKg * rate;
      const gstAmount = calcGst(shortageKg, rate);
      creditNoteAmount = baseAmount + gstAmount;
    } else {
      shortageKg = 0;
      creditNoteAmount = 0;
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (shortageKg && creditNoteAmount && shortageKg > 0) {
      const rate = Number(order.ratePerKg);
      const baseAmount = shortageKg * rate;
      const gstAmount = calcGst(shortageKg, rate);

      await LedgerService.postSaleCreditNote(tx, order.id, {
        buyerName: order.buyer.name,
        product: order.product,
        shortageKg,
        baseAmount,
        gstAmount,
      });
    }

    return tx.saleOrder.update({
      where: { id: order.id },
      data: {
        status: 'REACHED',
        receivedDate: new Date(),
        ...(data.buyerKataKg !== undefined && {
          buyerKataKg: data.buyerKataKg,
          shortageKg,
          creditNoteAmount,
        }),
        ...(kataFile && { buyerKataFileUrl: fileUrl(kataFile.filename) }),
      },
      include: { buyer: true, broker: true },
    });
  });

  res.json(updated);
}

/**
 * Mark a reached order as delivered (REACHED -> DELIVERED). Records the
 * deliveredDate which is used as the anchor for the payment due date.
 * Optionally stores the buyer's kata slip file.
 */
export async function deliverSaleOrder(req: Request, res: Response) {
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  const kataFile = files?.kata?.[0];

  const order = await prisma.saleOrder.findUnique({
    where: { id: req.params.id },
    include: { buyer: true, broker: true },
  });
  if (!order) throw new HttpError(404, 'Sale order not found');
  if (order.status !== 'REACHED') {
    throw new HttpError(400, `Cannot mark a ${order.status} order as delivered`);
  }

  // Delivery confirmed (buyer's kata slip in): release the freight retention
  // held back at dispatch to Surya Roadlines. Mirrors the retention held there.
  const company = await getCompanyProfileRow();
  const freightRetention =
    Number(order.freightCharge) > 0 ? Number(company.freightRetentionPerTrip ?? 3000) : 0;

  const updated = await prisma.$transaction(async (tx) => {
    await LedgerService.postFreightRetentionRelease(tx, order.id, freightRetention);

    return tx.saleOrder.update({
      where: { id: order.id },
      data: {
        status: 'DELIVERED',
        deliveredDate: new Date(),
        ...(kataFile && { buyerKataFileUrl: fileUrl(kataFile.filename) }),
      },
      include: { buyer: true, broker: true },
    });
  });

  res.json(updated);
}
