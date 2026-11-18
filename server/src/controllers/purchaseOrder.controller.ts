import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import {
  createPurchaseOrderSchema,
  listPurchaseOrdersSchema,
} from '../schemas/purchase.schema.js';
import { computeFY, derivePartyPrefix, formatPoNumber, normalizeSeriesKey, releasePoSerial, reservePoSerials } from '../lib/poNumber.js';
import { whatsappService } from '../services/whatsapp.service.js';
import { clearCache } from '../lib/cache.js';
import { nextRequirementCode } from '../lib/lorryCode.js';

export async function listPurchaseOrders(req: Request, res: Response) {
  const { status, skip, take, all } = listPurchaseOrdersSchema.parse(req.query);
  const isAll = all === 'true';
  const orders = await prisma.purchaseOrder.findMany({
    skip: isAll ? undefined : skip,
    take: isAll ? undefined : take,
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

function partySeriesKey(party: { nickname?: string | null; name: string }): string {
  if (party.nickname && party.nickname.trim()) return normalizeSeriesKey(party.nickname);
  return derivePartyPrefix(party.name);
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
    const seriesKey = partySeriesKey(party);
    const fy = computeFY(data.poDate);
    const startSerial = await reservePoSerials(tx, seriesKey, fy, numLorries);

    for (let i = 0; i < numLorries; i++) {
      const serial = startSerial + i;
      const isLast = i === numLorries - 1;
      const poTonnage = isLast ? (data.tonnageKg - (unitTonnageKg * (numLorries - 1))) : unitTonnageKg;

      const newPo = await tx.purchaseOrder.create({
        data: {
          poNumber: formatPoNumber(seriesKey, serial, fy),
          poSeriesKey: seriesKey,
          poSerial: serial,
          poFy: fy,
          poDate: data.poDate,
          partyId: data.partyId,
          pricePerKg: data.pricePerKg,
          priceType: data.priceType,
          plannedLocation: data.plannedLocation,
          tonnageKg: poTonnage,
          hasGst: data.hasGst,
          gstAmount: data.hasGst ? (poTonnage * data.pricePerKg * 0.05) : 0,
          lorryCount: 1, // each PO represents exactly 1 lorry
          poGroupId,
          createdBy: req.user!.userId,
        },
        include: { party: true },
      });
      createdPOs.push(newPo);
    }
  });

  // WhatsApp the party (lorries + price) - fire-and-forget, never blocks the PO.
  // The tonnage is quoted back only when asked for: the order's total, not the
  // per-lorry split, since that is the figure the party gave us.
  void whatsappService.notifyPoCreated(
    createdPOs.map((po) => ({ id: po.id, poNumber: po.poNumber })),
    { name: party.name, phone: party.phone, phone2: party.phone2, waLanguage: party.waLanguage },
    Number(data.pricePerKg),
    data.sendTonnageInMessage ? data.tonnageKg : null
  );

  clearCache('pappu_order_margins');
  clearCache('unified_stock_engine');

  res.status(201).json(createdPOs[0]);
}

export async function bulkCreatePurchaseOrders(req: Request, res: Response) {
  const { orders } = req.body as {
    orders: Array<{
      poDate: string;
      partyId: string;
      pricePerKg: number;
      priceType?: 'BASE' | 'DELIVERY';
      tonnageKg: number;
      lorryCount?: number;
    }>;
  };
  if (!Array.isArray(orders) || orders.length === 0) throw new HttpError(400, 'orders array is required');

  const results: Array<{ index: number; success: boolean; poNumber?: string; error?: string }> = [];

  for (let i = 0; i < orders.length; i++) {
    try {
      // Re-use the same core create logic by constructing a minimal mock req/res
      const row = orders[i];
      const parsed = createPurchaseOrderSchema.parse({
        poDate: row.poDate,
        partyId: row.partyId,
        pricePerKg: row.pricePerKg,
        priceType: row.priceType ?? 'DELIVERY',
        tonnageKg: row.tonnageKg,
        lorryCount: row.lorryCount,
      });

      const party = await prisma.party.findUnique({ where: { id: parsed.partyId } });
      if (!party) throw new Error('Party not found');

      const numLorries = parsed.lorryCount && parsed.lorryCount > 0 ? parsed.lorryCount : Math.max(1, Math.round(parsed.tonnageKg / 25000));
      const unitTonnageKg = Math.round(parsed.tonnageKg / numLorries);
      const poGroupId = randomUUID();
      let firstPoNumber = '';

      await prisma.$transaction(async (tx) => {
        const seriesKey = partySeriesKey(party);
        const fy = computeFY(parsed.poDate);
        const startSerial = await reservePoSerials(tx, seriesKey, fy, numLorries);
        for (let j = 0; j < numLorries; j++) {
          const serial = startSerial + j;
          const poNumber = formatPoNumber(seriesKey, serial, fy);
          const isLast = j === numLorries - 1;
          const poTonnage = isLast ? (parsed.tonnageKg - unitTonnageKg * (numLorries - 1)) : unitTonnageKg;
          if (j === 0) firstPoNumber = poNumber;
          await tx.purchaseOrder.create({
            data: {
              poNumber,
              poSeriesKey: seriesKey,
              poSerial: serial,
              poFy: fy,
              poDate: parsed.poDate,
              partyId: parsed.partyId,
              pricePerKg: parsed.pricePerKg,
              priceType: parsed.priceType,
              plannedLocation: parsed.plannedLocation,
              hasGst: parsed.hasGst,
              gstAmount: parsed.hasGst ? (poTonnage * Number(parsed.pricePerKg) * 0.05) : 0,
              tonnageKg: poTonnage,
              lorryCount: 1,
              poGroupId,
              createdBy: req.user!.userId,
            },
          });
        }
      });

      results.push({ index: i, success: true, poNumber: firstPoNumber });
    } catch (err: unknown) {
      results.push({ index: i, success: false, error: err instanceof Error ? err.message : 'Unknown error' });
    }
  }

  clearCache('pappu_order_margins');
  clearCache('unified_stock_engine');

  res.json({ results });
}

export async function updatePurchaseOrder(req: Request, res: Response) {
  const data = createPurchaseOrderSchema.parse(req.body);
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: req.params.id },
    include: { stockIns: true },
  });
  if (!po) throw new HttpError(404, 'Purchase order not found');
  
  if (po.stockIns.length > 0) {
    if (data.partyId !== po.partyId || Number(data.pricePerKg) !== Number(po.pricePerKg) || data.priceType !== po.priceType) {
      throw new HttpError(400, 'Cannot change Party or Price after lorries have arrived.');
    }
    const arrivedKg = po.stockIns.reduce((sum, si) => sum + Math.max(si.rvpKataKg, si.rvpFirstWeightKg), 0);
    if (data.tonnageKg < arrivedKg) {
      throw new HttpError(400, `Cannot reduce tonnage below arrived quantity (${arrivedKg} kg)`);
    }
  }

  const updated = await prisma.purchaseOrder.update({
    where: { id: req.params.id },
    data: {
      poDate: data.poDate,
      partyId: data.partyId,
      pricePerKg: data.pricePerKg,
      priceType: data.priceType,
      plannedLocation: data.plannedLocation,
      hasGst: data.hasGst,
      gstAmount: data.hasGst ? (data.tonnageKg * data.pricePerKg * 0.05) : 0,
      tonnageKg: data.tonnageKg,
      lorryCount: data.lorryCount,
    },
    include: { party: true },
  });

  clearCache('pappu_order_margins');
  clearCache('unified_stock_engine');

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
  await prisma.$transaction(async (tx) => {
    await tx.purchaseOrder.delete({
      where: { id: req.params.id },
    });
    // Roll the serial counter back so the freed PO number is reused next time.
    if (po.poSeriesKey && po.poFy) {
      await releasePoSerial(tx, po.poSeriesKey, po.poFy);
    }
  });

  clearCache('pappu_order_margins');
  clearCache('unified_stock_engine');

  res.json({ message: 'Purchase order deleted' });
}

/**
 * Void a purchase order - set status to CANCELLED without deleting. Allows
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

  clearCache('pappu_order_margins');
  clearCache('unified_stock_engine');

  res.json(updated);
}

/**
 * Unvoid (restore) a cancelled purchase order - set status back to PENDING.
 */
export async function unvoidPurchaseOrder(req: Request, res: Response) {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: req.params.id },
    include: { party: true },
  });
  if (!po) throw new HttpError(404, 'Purchase order not found');
  if (po.status !== 'CANCELLED') {
    throw new HttpError(400, 'Only cancelled purchase orders can be restored');
  }
  const updated = await prisma.purchaseOrder.update({
    where: { id: req.params.id },
    data: { status: 'PENDING' },
    include: { party: true },
  });

  clearCache('pappu_order_margins');
  clearCache('unified_stock_engine');

  res.json(updated);
}

/**
 * Issue (or re-read) the requirement code for a purchase order, and build the
 * message that goes to the transporter.
 *
 * Idempotent: a PO that already has a code hands back the same one. The code is
 * what the transporter quotes on the first line of his reply, so minting a
 * second one for the same lorry would leave two codes in the conversation and
 * put his booking on neither.
 *
 * The message is returned as text rather than sent. Transporters are messaged
 * from whichever handset is doing the asking, over an ordinary chat - there is
 * no approved template for "I need a lorry", and a requirement is usually
 * haggled over before it is agreed.
 */
export async function issueRequirementCode(req: Request, res: Response) {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: req.params.id },
    select: {
      id: true,
      poNumber: true,
      poDate: true,
      tonnageKg: true,
      requirementCode: true,
      party: { select: { name: true, city: true } },
    },
  });
  if (!po) throw new HttpError(404, 'Purchase order not found');

  const code = po.requirementCode ?? (await nextRequirementCode(new Date()));
  if (!po.requirementCode) {
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { requirementCode: code } });
  }

  const company = await prisma.companyProfile.findFirst({ select: { name: true, dispatchFromPlace: true } });
  const to = `${company?.name || 'RVP Industries'}, ${company?.dispatchFromPlace?.trim() || 'Punganur'}`;
  const from = po.party?.city?.trim() || po.party?.name || '-';
  const mt = (po.tonnageKg / 1000).toFixed(2).replace(/\.00$/, '');

  // The reply format, spelled out in the same order it should come back in. The
  // transporter is being asked to copy a shape, not fill a form - so the code
  // sits on its own first line, which is the one line the parser depends on.
  const message = [
    `${code}`,
    `Lorry required: ${from} to ${to}`,
    `Load: ${mt} MT black seed`,
    '',
    'Please reply with:',
    code,
    '<lorry number>',
    '<driver mobile>',
    `${mt}MT`,
    '<body type>',
    '<loading place>',
  ].join('\n');

  res.json({ code, message, poNumber: po.poNumber });
}
