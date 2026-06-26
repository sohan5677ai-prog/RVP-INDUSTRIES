import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { createStockInSchema } from '../schemas/purchase.schema.js';
import { fileUrl } from '../lib/upload.js';
import { extractInvoiceData, type DocumentKind } from '../lib/gemini.js';

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
 * anything — the file is held in memory only for the duration of the call.
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
  console.log(`[extract:${kind}]`, JSON.stringify(data));
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
      },
    });

    const nextStatus = (arrivedCount + 1 >= lorryCount) ? 'ARRIVED' : 'PENDING';
    await tx.purchaseOrder.update({
      where: { id: data.purchaseOrderId },
      data: { status: nextStatus },
    });
    return created;
  });

  res.status(201).json(stockIn);
}

export async function updateStockIn(req: Request, res: Response) {
  const data = createStockInSchema.parse(req.body);
  const stockIn = await prisma.stockIn.findUnique({
    where: { id: req.params.id },
    include: { purchase: true, purchaseOrder: true },
  });
  if (!stockIn) throw new HttpError(404, 'Stock-in not found');
  if (stockIn.purchase) {
    throw new HttpError(400, 'Cannot edit stock-in that has already been purchased');
  }

  const invoiceFileUrl = req.file ? fileUrl(req.file.filename) : stockIn.invoiceFileUrl;

  const rvpSecondWeightKg = data.rvpSecondWeightKg ?? 0;
  const rvpKataKg = rvpSecondWeightKg > 0 ? (data.rvpFirstWeightKg - rvpSecondWeightKg) : 0;

  const updated = await prisma.stockIn.update({
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
    },
  });
  res.json(updated);
}

export async function deleteStockIn(req: Request, res: Response) {
  const stockIn = await prisma.stockIn.findUnique({
    where: { id: req.params.id },
    include: { purchase: true },
  });
  if (!stockIn) throw new HttpError(404, 'Stock-in not found');
  if (stockIn.purchase) {
    throw new HttpError(400, 'Cannot delete stock-in that has already been purchased');
  }

  await prisma.$transaction(async (tx) => {
    await tx.stockIn.delete({ where: { id: req.params.id } });
    await tx.purchaseOrder.update({
      where: { id: stockIn.purchaseOrderId },
      data: { status: 'PENDING' },
    });
  });
  res.json({ message: 'Stock-in deleted' });
}
