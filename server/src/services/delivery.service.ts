import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { clearCache } from '../lib/cache.js';
import { computePappuOrderMargins } from '../controllers/inventory.controller.js';
import type { SaleDispatch } from '@prisma/client';

const GST_RATE = 0.05;

/** GST on weight × rate at the given fraction (default 5%), rounded to paise. */
export function calcGst(weightKg: number, ratePerKg: number, fraction: number = GST_RATE): number {
  return Math.round(weightKg * ratePerKg * fraction * 100) / 100;
}

/** GST fraction (e.g. 0.05) configured for a commodity in Settings; defaults to 5%. */
export async function gstFractionForProduct(product: string): Promise<number> {
  const info = await prisma.productTaxInfo.findUnique({ where: { product: product as any } });
  const pct = info?.gstRate != null ? Number(info.gstRate) : 5;
  return pct / 100;
}

export async function freezeOrderCost(orderId: string) {
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

export interface ConfirmDeliveryArgs {
  dispatchId: string;
  buyerKataKg?: number;
  deliveredDate?: Date;
  buyerKataFileUrl?: string | null;
  submissionId?: string;
  confirmedBy?: string;
}

/**
 * Shared delivery confirmation logic used by:
 * 1. Web UI delivery modal (POST /sale-dispatches/:id/deliver)
 * 2. Slack Driver Kata interactive confirmation
 */
export async function confirmDelivery(args: ConfirmDeliveryArgs): Promise<SaleDispatch> {
  const { dispatchId, buyerKataKg, deliveredDate, buyerKataFileUrl, submissionId, confirmedBy } = args;

  const dispatch = await prisma.saleDispatch.findUnique({
    where: { id: dispatchId },
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

  // Delivery is practically impossible before the shipment left
  if (deliveredDate) {
    const dispatchDay = dispatch.dispatchDate.toISOString().slice(0, 10);
    const deliveredDay = deliveredDate.toISOString().slice(0, 10);
    if (deliveredDay < dispatchDay) {
      throw new HttpError(400, 'Delivered date cannot be before the dispatch date.');
    }
  }

  const order = dispatch.saleOrder;
  const rate = Number(order.ratePerKg);
  let orderIsFullyShipped = false;

  let shortageKg: number | null = null;
  let creditNoteAmount: number | null = null;

  if (buyerKataKg !== undefined) {
    // If buyer's kata is higher (e.g. moisture gain in transit or scale variance),
    // the shortage is 0 (no credit note). Billing stays for dispatched weight as per invoice.
    shortageKg = Math.max(0, dispatch.weightKg - buyerKataKg);
    creditNoteAmount = shortageKg > 0 ? shortageKg * rate + (order.gstExempt ? 0 : calcGst(shortageKg, rate, await gstFractionForProduct(order.product))) : 0;
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.saleDispatch.update({
      where: { id: dispatch.id },
      data: {
        status: 'DELIVERED',
        receivedDate: dispatch.receivedDate ?? (deliveredDate ?? new Date()),
        deliveredDate: deliveredDate ?? new Date(),
        ...(buyerKataKg !== undefined && {
          buyerKataKg,
          shortageKg,
          creditNoteAmount,
        }),
        ...(buyerKataFileUrl && { buyerKataFileUrl }),
      },
      include: { saleOrder: { include: { buyer: true, broker: true } } },
    });

    const siblings = await tx.saleDispatch.findMany({ where: { saleOrderId: order.id } });
    const dispatchedKg = siblings.reduce((s, d) => s + d.weightKg, 0);
    const orderStatus = dispatchedKg < order.tonnageKg
      ? 'PARTIAL'
      : siblings.every((d) => d.status === 'DELIVERED') ? 'DELIVERED' : 'DISPATCHED';
    orderIsFullyShipped = orderStatus !== 'PARTIAL';
    await tx.saleOrder.update({ where: { id: order.id }, data: { status: orderStatus } });

    if (submissionId) {
      await tx.driverKataSubmission.update({
        where: { id: submissionId },
        data: {
          status: 'APPROVED',
          confirmedKg: buyerKataKg,
          confirmedBy: confirmedBy ?? null,
          confirmedAt: new Date(),
        },
      });
    }

    return result;
  });

  if (order.product === 'PAPPU' && orderIsFullyShipped) {
    await freezeOrderCost(order.id);
  }

  return updated;
}
