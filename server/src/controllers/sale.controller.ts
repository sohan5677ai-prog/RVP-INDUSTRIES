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
import { AllocationService } from '../services/allocation.service.js';
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

  // Gap 5: Block PAPPU sale order creation if there are no POs to back it
  if (data.product === 'PAPPU') {
    const capacity = await AllocationService.checkAllocationCapacity(
      data.tonnageKg,
      Number(data.ratePerKg)
    );
    if (!capacity.canAllocate) {
      throw new HttpError(
        409,
        capacity.reason ?? 'Insufficient PO capacity to create this sale order.'
      );
    }
  }

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

  let allocationSummary = null;
  if (data.product === 'PAPPU') {
    // Trigger Soft Allocation
    const totalAllocated = await AllocationService.allocateSaleOrder(order.id, data.tonnageKg);
    const unallocatedKg = data.tonnageKg - totalAllocated;

    allocationSummary = {
      totalAllocatedKg: Math.round(totalAllocated),
      unallocatedKg: Math.round(unallocatedKg),
      warning: unallocatedKg > 0
        ? `⚠️ Only ${Math.round(totalAllocated / 1000)}T of ${Math.round(data.tonnageKg / 1000)}T could be allocated against existing POs. ${Math.round(unallocatedKg / 1000)}T is UNALLOCATED.`
        : null,
    };
  }

  res.status(201).json({ ...order, allocationSummary });
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

      const order = await prisma.saleOrder.create({
        data: {
          saleDate: data.saleDate,
          product: data.product,
          buyerId: data.buyerId,
          tonnageKg: data.tonnageKg,
          ratePerKg: data.ratePerKg,
          dueDays: data.dueDays ?? null,
          gstAmount: calcGst(data.tonnageKg, Number(data.ratePerKg)),
          brokerageRatePerKg: 0,
          destination,
          freightCharge,
          marginOverride: data.marginOverride || false,
        },
      });

      if (data.product === 'PAPPU') {
        await AllocationService.allocateSaleOrder(order.id, data.tonnageKg);
      }

      results.push({ index: i, success: true, id: order.id });
    } catch (err: any) {
      results.push({ index: i, success: false, error: err?.message ?? 'Unknown error' });
    }
  }

  res.json({ results });
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

  if (data.product === 'PAPPU') {
    const capacity = await AllocationService.checkAllocationCapacity(
      data.tonnageKg,
      Number(data.ratePerKg),
      order.id
    );
    if (!capacity.canAllocate) {
      throw new HttpError(
        409,
        capacity.reason ?? 'Insufficient PO capacity to update this sale order.'
      );
    }
  }

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

  let allocationSummary = null;
  if (data.product === 'PAPPU') {
    // Delete existing allocations since we are re-allocating
    await prisma.saleAllocation.deleteMany({
      where: { saleOrderId: updated.id }
    });
    
    // Trigger Soft Allocation
    const totalAllocated = await AllocationService.allocateSaleOrder(updated.id, data.tonnageKg);
    const unallocatedKg = data.tonnageKg - totalAllocated;

    allocationSummary = {
      totalAllocatedKg: Math.round(totalAllocated),
      unallocatedKg: Math.round(unallocatedKg),
      warning: unallocatedKg > 0
        ? `⚠️ Only ${Math.round(totalAllocated / 1000)}T of ${Math.round(data.tonnageKg / 1000)}T could be allocated against existing POs. ${Math.round(unallocatedKg / 1000)}T is UNALLOCATED.`
        : null,
    };
  }

  res.json({ ...updated, allocationSummary });
}

export async function deleteSaleOrder(req: Request, res: Response) {
  const order = await prisma.saleOrder.findUnique({ where: { id: req.params.id } });
  if (!order) throw new HttpError(404, 'Sale order not found');
  if (order.status !== 'PENDING') {
    throw new HttpError(400, 'Cannot delete a sale order that is already dispatched');
  }
  await prisma.$transaction([
    prisma.saleAllocation.deleteMany({ where: { saleOrderId: req.params.id } }),
    prisma.saleOrder.delete({ where: { id: req.params.id } })
  ]);
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
 * Dispatch a (partial) quantity of a sale order: store the uploaded kata slip,
 * record the confirmed vehicle no / kata tonnage as one SaleDispatch, then bill
 * (revenue + GST + freight) and — for Pappu — deplete the pool with COGS. The tax
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

  // Fully dispatched once this lorry takes the remaining balance to (or below) zero.
  const fullyDispatched = alreadyDispatchedKg + weightKg >= order.tonnageKg;

  const dispatch = await prisma.$transaction(async (tx) => {
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
 * Raise the tax invoice for an already-dispatched shipment. Auto-assigns the next
 * invoice number (prefix/seq/FY, sequence resets each financial year) and stamps
 * the invoice date. The sale was already billed at dispatch, so no new ledger
 * entry is posted. Idempotent — re-raising keeps the existing number.
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
    creditNoteAmount = shortageKg > 0 ? shortageKg * rate + calcGst(shortageKg, rate) : 0;
    
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
