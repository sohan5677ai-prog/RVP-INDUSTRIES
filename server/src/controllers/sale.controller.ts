import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import {
  createSaleOrderSchema,
  listSaleOrdersSchema,
  createSaleDispatchSchema,
} from '../schemas/sale.schema.js';
import { fileUrl } from '../lib/upload.js';
import { InventoryService } from '../services/inventory.service.js';
import { LedgerService } from '../services/ledger.service.js';

export async function listSaleOrders(req: Request, res: Response) {
  const { status } = listSaleOrdersSchema.parse(req.query);
  const orders = await prisma.saleOrder.findMany({
    where: status ? { status } : undefined,
    orderBy: { saleDate: 'desc' },
    include: { buyer: true, broker: true, dispatch: true },
  });
  res.json(orders);
}

export async function getSaleOrder(req: Request, res: Response) {
  const order = await prisma.saleOrder.findUnique({
    where: { id: req.params.id },
    include: { buyer: true, broker: true, dispatch: true },
  });
  if (!order) throw new HttpError(404, 'Sale order not found');
  res.json(order);
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

  // Margin Check: 3% profit margin required over live Finished Pappu MAP
  const finishedMAP = await InventoryService.getMAP('WHITE_PAPPU', 'Finished Silo');
  const rate = Number(data.ratePerKg);
  const minRateRequired = finishedMAP * 1.03;

  if (finishedMAP > 0 && rate < minRateRequired && !data.marginOverride) {
    throw new HttpError(
      403,
      `Selling price (₹${rate.toFixed(2)}/kg) is below the minimum 3% profit margin requirement over the live moving average cost of White Pappu (₹${finishedMAP.toFixed(2)}/kg). Minimum required: ₹${minRateRequired.toFixed(2)}/kg. Admin override is required.`
    );
  }

  const order = await prisma.saleOrder.create({
    data: {
      saleDate: data.saleDate,
      buyerId: data.buyerId,
      brokerId: data.brokerId ?? null,
      tonnageKg: data.tonnageKg,
      ratePerKg: data.ratePerKg,
      marginOverride: data.marginOverride || false,
    },
    include: { buyer: true, broker: true },
  });
  res.status(201).json(order);
}

export async function createSaleDispatch(req: Request, res: Response) {
  if (!req.file) throw new HttpError(400, 'Invoice file is required');
  const data = createSaleDispatchSchema.parse(req.body);

  const order = await prisma.saleOrder.findUnique({
    where: { id: data.saleOrderId },
    include: { dispatch: true, buyer: true },
  });
  if (!order) throw new HttpError(400, 'Sale order not found');
  if (order.dispatch) throw new HttpError(409, 'Sale order already dispatched');

  const dispatch = await prisma.$transaction(async (tx) => {
    // 1. Consume finished goods inventory and calculate COGS using finished MAP
    const cogsAmount = await InventoryService.consumeFinishedPappuInventory(tx, data.dispatchWeightKg);

    // 2. Create the dispatch record
    const created = await tx.saleDispatch.create({
      data: {
        saleOrderId: data.saleOrderId,
        dispatchDate: data.dispatchDate,
        dispatchWeightKg: data.dispatchWeightKg,
        invoiceFileUrl: fileUrl(req.file!.filename),
      },
    });

    // 3. Update sale order status to DISPATCHED
    await tx.saleOrder.update({
      where: { id: data.saleOrderId },
      data: { status: 'DISPATCHED' },
    });

    // 4. Post Ledger Entry (Debit A/R, Credit Sales Revenue; Debit COGS, Credit Finished Inventory)
    const invoiceAmount = Number(order.ratePerKg) * data.dispatchWeightKg;
    await LedgerService.postSaleDispatch(tx, created.id, {
      buyerName: order.buyer.name,
      invoiceAmount,
      cogsAmount,
      dispatchWeightKg: data.dispatchWeightKg,
    });

    return created;
  });

  res.status(201).json({
    ...dispatch,
    ewayBillNumber: "849204910394",
    ewayBillStatus: "GENERATED",
    ewayBillMessage: "E-Way Bill generated automatically via logistics portal API simulation."
  });
}

export async function updateSaleOrder(req: Request, res: Response) {
  const data = createSaleOrderSchema.parse(req.body);
  const order = await prisma.saleOrder.findUnique({
    where: { id: req.params.id },
    include: { dispatch: true },
  });
  if (!order) throw new HttpError(404, 'Sale order not found');
  if (order.status !== 'PENDING' || order.dispatch) {
    throw new HttpError(400, 'Cannot edit sale order that is already dispatched or completed');
  }

  // Margin Check: 3% profit margin required over live Finished Pappu MAP
  const finishedMAP = await InventoryService.getMAP('WHITE_PAPPU', 'Finished Silo');
  const rate = Number(data.ratePerKg);
  const minRateRequired = finishedMAP * 1.03;

  if (finishedMAP > 0 && rate < minRateRequired && !data.marginOverride) {
    throw new HttpError(
      403,
      `Selling price (₹${rate.toFixed(2)}/kg) is below the minimum 3% profit margin requirement over the live moving average cost of White Pappu (₹${finishedMAP.toFixed(2)}/kg). Minimum required: ₹${minRateRequired.toFixed(2)}/kg. Admin override is required.`
    );
  }

  const updated = await prisma.saleOrder.update({
    where: { id: req.params.id },
    data: {
      saleDate: data.saleDate,
      buyerId: data.buyerId,
      brokerId: data.brokerId ?? null,
      tonnageKg: data.tonnageKg,
      ratePerKg: data.ratePerKg,
      marginOverride: data.marginOverride || false,
    },
    include: { buyer: true, broker: true },
  });
  res.json(updated);
}

export async function deleteSaleOrder(req: Request, res: Response) {
  const order = await prisma.saleOrder.findUnique({
    where: { id: req.params.id },
    include: { dispatch: true },
  });
  if (!order) throw new HttpError(404, 'Sale order not found');
  if (order.status !== 'PENDING' || order.dispatch) {
    throw new HttpError(400, 'Cannot delete sale order that is already dispatched or completed');
  }

  await prisma.saleOrder.delete({
    where: { id: req.params.id },
  });
  res.json({ message: 'Sale order deleted' });
}

export async function recordBuyerWeight(req: Request, res: Response) {
  const buyerWeightKg = Number(req.body.buyerWeightKg);
  if (isNaN(buyerWeightKg) || buyerWeightKg <= 0) {
    throw new HttpError(400, 'Buyer received weight must be positive');
  }

  const dispatch = await prisma.saleDispatch.findUnique({
    where: { id: req.params.id },
    include: { saleOrder: { include: { buyer: true } } },
  });
  if (!dispatch) throw new HttpError(404, 'Dispatch record not found');

  const dispatchWeightKg = dispatch.dispatchWeightKg;
  let creditNoteAmount = 0;
  let creditNoteReason = null;

  if (buyerWeightKg < dispatchWeightKg) {
    const shortageKg = dispatchWeightKg - buyerWeightKg;
    const ratePerKg = Number(dispatch.saleOrder.ratePerKg);
    creditNoteAmount = shortageKg * ratePerKg;
    creditNoteReason = `Shortage discrepancy of ${shortageKg} kg (Dispatch: ${dispatchWeightKg} kg, Buyer: ${buyerWeightKg} kg) @ ${ratePerKg}/kg`;
  }

  const updated = await prisma.$transaction(async (tx) => {
    const sd = await tx.saleDispatch.update({
      where: { id: req.params.id },
      data: {
        buyerWeightKg,
        creditNoteAmount: creditNoteAmount > 0 ? creditNoteAmount : null,
        creditNoteReason,
      },
    });

    await tx.saleOrder.update({
      where: { id: dispatch.saleOrderId },
      data: { status: 'COMPLETED' },
    });

    if (creditNoteAmount > 0) {
      const shortageKg = dispatchWeightKg - buyerWeightKg;
      await LedgerService.postSaleDispute(tx, sd.id, {
        buyerName: dispatch.saleOrder.buyer.name,
        creditNoteAmount,
        shortageKg,
      });
    }

    return sd;
  });

  res.json(updated);
}
