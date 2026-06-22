import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import {
  createPurchaseOrderSchema,
  listPurchaseOrdersSchema,
} from '../schemas/purchase.schema.js';

export async function listPurchaseOrders(req: Request, res: Response) {
  const { status } = listPurchaseOrdersSchema.parse(req.query);
  const orders = await prisma.purchaseOrder.findMany({
    where: status ? { status } : undefined,
    orderBy: { poDate: 'desc' },
    include: { party: true, stockIns: { select: { id: true } } },
  });
  res.json(orders);
}

export async function getPurchaseOrder(req: Request, res: Response) {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: req.params.id },
    include: {
      party: true,
      stockIns: {
        include: {
          purchase: {
            include: {
              verification: true,
              processing: true,
            },
          },
        },
      },
    },
  });
  if (!po) throw new HttpError(404, 'Purchase order not found');
  res.json(po);
}

function getPartyPrefix(partyName: string): string {
  const words = partyName.trim().split(/\s+/);
  if (words.length > 1) {
    const initials = words
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    if (initials.length >= 2) return initials;
  }
  return partyName.slice(0, 3).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export async function createPurchaseOrder(req: Request, res: Response) {
  const data = createPurchaseOrderSchema.parse(req.body);

  const party = await prisma.party.findUnique({ where: { id: data.partyId } });
  if (!party) throw new HttpError(400, 'Party not found');

  const numLorries = data.lorryCount && data.lorryCount > 0 ? data.lorryCount : Math.max(1, Math.round(data.tonnageKg / 25000));
  const unitTonnageKg = Math.round(data.tonnageKg / numLorries);
  // One shared id ties all the per-lorry POs from this order together.
  const poGroupId = randomUUID();
  const createdPOs: any[] = [];

  await prisma.$transaction(async (tx) => {
    const prefix = getPartyPrefix(party.name);
    const lastPo = await tx.purchaseOrder.findFirst({
      where: { poNumber: { startsWith: `${prefix}-` } },
      orderBy: { poNumber: 'desc' }, // Order by poNumber descending to find the highest number
    });

    let nextNum = 1;
    if (lastPo && lastPo.poNumber) {
      const parts = lastPo.poNumber.split('-');
      const numPart = parts[parts.length - 1];
      const num = parseInt(numPart, 10);
      if (!isNaN(num)) {
        nextNum = num + 1;
      }
    }

    for (let i = 0; i < numLorries; i++) {
      const currentPoNumber = `${prefix}-${(nextNum + i).toString().padStart(3, '0')}`;
      const isLast = i === numLorries - 1;
      const poTonnage = isLast ? (data.tonnageKg - (unitTonnageKg * (numLorries - 1))) : unitTonnageKg;

      const newPo = await tx.purchaseOrder.create({
        data: {
          poNumber: currentPoNumber,
          poDate: data.poDate,
          partyId: data.partyId,
          pricePerKg: data.pricePerKg,
          priceType: data.priceType,
          tonnageKg: poTonnage,
          lorryCount: 1, // each PO represents exactly 1 lorry
          poGroupId,
          createdBy: req.user!.userId,
        },
        include: { party: true },
      });
      createdPOs.push(newPo);
    }
  });

  res.status(201).json(createdPOs[0]);
}

export async function updatePurchaseOrder(req: Request, res: Response) {
  const data = createPurchaseOrderSchema.parse(req.body);
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: req.params.id },
    include: { stockIns: true },
  });
  if (!po) throw new HttpError(404, 'Purchase order not found');
  if (po.stockIns.length > 0) {
    throw new HttpError(400, 'Cannot edit purchase order that has already arrived (has stock-in)');
  }
  const updated = await prisma.purchaseOrder.update({
    where: { id: req.params.id },
    data: {
      poDate: data.poDate,
      partyId: data.partyId,
      pricePerKg: data.pricePerKg,
      priceType: data.priceType,
      tonnageKg: data.tonnageKg,
      lorryCount: data.lorryCount,
    },
    include: { party: true },
  });
  res.json(updated);
}

export async function deletePurchaseOrder(req: Request, res: Response) {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: req.params.id },
    include: { stockIns: true },
  });
  if (!po) throw new HttpError(404, 'Purchase order not found');
  if (po.stockIns.length > 0) {
    throw new HttpError(400, 'Cannot delete purchase order that has already arrived (has stock-in)');
  }
  await prisma.purchaseOrder.delete({
    where: { id: req.params.id },
  });
  res.json({ message: 'Purchase order deleted' });
}

/**
 * Void a purchase order — set status to CANCELLED without deleting. Allows
 * tracking cancelled orders in the history. Works on any PENDING PO.
 */
export async function voidPurchaseOrder(req: Request, res: Response) {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: req.params.id },
    include: { party: true },
  });
  if (!po) throw new HttpError(404, 'Purchase order not found');
  if (po.status === 'CANCELLED') {
    throw new HttpError(400, 'Purchase order is already cancelled');
  }
  if (po.status === 'COMPLETED') {
    throw new HttpError(400, 'Cannot void a completed purchase order');
  }
  const updated = await prisma.purchaseOrder.update({
    where: { id: req.params.id },
    data: { status: 'CANCELLED' },
    include: { party: true },
  });
  res.json(updated);
}
