import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { computeFY } from '../lib/poNumber.js';
import { getCompanyProfileRow } from './settings.controller.js';
import { TaxproService } from '../services/taxpro.service.js';
import { z } from 'zod';

const itemSchema = z.object({
  productName: z.string().min(1, 'Product name is required'),
  hsnCode: z.string().min(2, 'HSN code is required'),
  quantity: z.coerce.number().positive('Quantity must be > 0'),
  unit: z.string().default('KGS'),
  taxableAmount: z.coerce.number().min(0),
  gstRate: z.coerce.number().min(0).default(0),
  cgstAmount: z.coerce.number().min(0).default(0),
  sgstAmount: z.coerce.number().min(0).default(0),
  igstAmount: z.coerce.number().min(0).default(0),
});

const deliveryChallanSchema = z.object({
  challanDate: z.string().or(z.date()),
  challanType: z.string().default('OTHERS'), // JOB_WORK, GODOWN_TRANSFER, SUPPLY_ON_APPROVAL, FOR_EXHIBITION, OTHERS
  subType: z.string().default('OTHERS'),
  
  // From details (defaults to company if omitted)
  fromName: z.string().optional(),
  fromGstin: z.string().optional(),
  fromAddress: z.string().optional(),
  fromPlace: z.string().optional(),
  fromPincode: z.coerce.number().int().optional(),
  fromStateCode: z.coerce.number().int().optional(),

  // To details
  toName: z.string().min(1, 'Recipient name is required'),
  toGstin: z.string().optional().default('URP'),
  toAddress: z.string().min(1, 'Recipient address is required'),
  toPlace: z.string().min(1, 'Recipient place/city is required'),
  toPincode: z.coerce.number().int().min(100000).max(999999, 'Invalid 6-digit pincode'),
  toStateCode: z.coerce.number().int().default(37),

  items: z.array(itemSchema).min(1, 'At least one item is required'),

  // Transport details
  transporterId: z.string().optional(),
  transporterName: z.string().optional(),
  transporterGstin: z.string().optional(),
  vehicleNumber: z.string().optional(),
  transDocNo: z.string().optional(),
  transDocDate: z.string().optional(),
  transMode: z.string().default('1'),
  vehicleType: z.string().default('R'),
  distanceKm: z.coerce.number().int().min(0).default(0),

  remarks: z.string().optional(),
});

export async function listDeliveryChallans(req: Request, res: Response) {
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;

  const where: any = {};
  if (status) where.status = status;
  if (search) {
    where.OR = [
      { challanNumber: { contains: search, mode: 'insensitive' } },
      { toName: { contains: search, mode: 'insensitive' } },
      { vehicleNumber: { contains: search, mode: 'insensitive' } },
      { ewbNumber: { contains: search, mode: 'insensitive' } },
    ];
  }

  const challans = await prisma.deliveryChallan.findMany({
    where,
    orderBy: { challanDate: 'desc' },
    take: 100,
  });

  res.json(challans);
}

export async function getDeliveryChallan(req: Request, res: Response) {
  const { id } = req.params;
  const challan = await prisma.deliveryChallan.findUnique({ where: { id } });
  if (!challan) throw new HttpError(404, 'Delivery Challan not found');
  res.json(challan);
}

export async function createDeliveryChallan(req: Request, res: Response) {
  const parsed = deliveryChallanSchema.parse(req.body);
  const company = await getCompanyProfileRow();

  const challanDate = new Date(parsed.challanDate);
  const fy = computeFY(challanDate);

  // Compute item totals
  let taxableValue = 0;
  let cgstAmount = 0;
  let sgstAmount = 0;
  let igstAmount = 0;

  for (const it of parsed.items) {
    taxableValue += it.taxableAmount;
    cgstAmount += it.cgstAmount;
    sgstAmount += it.sgstAmount;
    igstAmount += it.igstAmount;
  }
  const totalValue = taxableValue + cgstAmount + sgstAmount + igstAmount;

  // From details fallback to company settings
  const fromName = parsed.fromName || company.name || 'RVP Industries';
  const fromGstin = parsed.fromGstin || company.gstin || '';
  const fromAddress = parsed.fromAddress || company.dispatchFromAddress1 || company.address || 'Premises';
  const fromPlace = parsed.fromPlace || company.dispatchFromPlace || 'Punganur';
  const fromPincode = parsed.fromPincode || Number(company.dispatchFromPincode || company.pincode) || 517247;
  const fromStateCode = parsed.fromStateCode || 37;

  const result = await prisma.$transaction(async (tx) => {
    const counter = await tx.challanSerialCounter.upsert({
      where: { fy },
      create: { fy, lastSerial: 1 },
      update: { lastSerial: { increment: 1 } },
    });
    const seq = counter.lastSerial;
    const challanNumber = `CHL/${fy}/${String(seq).padStart(4, '0')}`;

    return tx.deliveryChallan.create({
      data: {
        challanNumber,
        challanSeq: seq,
        challanFy: fy,
        challanDate,
        challanType: parsed.challanType,
        subType: parsed.subType,
        fromName,
        fromGstin,
        fromAddress,
        fromPlace,
        fromPincode,
        fromStateCode,
        toName: parsed.toName,
        toGstin: parsed.toGstin || 'URP',
        toAddress: parsed.toAddress,
        toPlace: parsed.toPlace,
        toPincode: parsed.toPincode,
        toStateCode: parsed.toStateCode,
        items: parsed.items,
        taxableValue,
        cgstAmount,
        sgstAmount,
        igstAmount,
        totalValue,
        transporterId: parsed.transporterId,
        transporterName: parsed.transporterName,
        transporterGstin: parsed.transporterGstin,
        vehicleNumber: parsed.vehicleNumber?.toUpperCase().replace(/\s+/g, ''),
        transDocNo: parsed.transDocNo,
        transDocDate: parsed.transDocDate ? new Date(parsed.transDocDate) : null,
        transMode: parsed.transMode,
        vehicleType: parsed.vehicleType,
        distanceKm: parsed.distanceKm,
        remarks: parsed.remarks,
        status: 'ACTIVE',
      },
    });
  });

  res.status(201).json(result);
}

export async function updateDeliveryChallan(req: Request, res: Response) {
  const { id } = req.params;
  const existing = await prisma.deliveryChallan.findUnique({ where: { id } });
  if (!existing) throw new HttpError(404, 'Delivery Challan not found');
  if (existing.ewbNumber && existing.ewbStatus !== 'CANCELLED') {
    throw new HttpError(400, 'Cannot edit a challan with an active E-Way Bill. Cancel E-Way Bill first.');
  }

  const parsed = deliveryChallanSchema.partial().parse(req.body);

  const updated = await prisma.deliveryChallan.update({
    where: { id },
    data: {
      ...parsed,
      items: parsed.items ? (parsed.items as any) : undefined,
      transDocDate: parsed.transDocDate ? new Date(parsed.transDocDate) : undefined,
    },
  });

  res.json(updated);
}

export async function cancelDeliveryChallan(req: Request, res: Response) {
  const { id } = req.params;
  const existing = await prisma.deliveryChallan.findUnique({ where: { id } });
  if (!existing) throw new HttpError(404, 'Delivery Challan not found');
  if (existing.ewbNumber && existing.ewbStatus !== 'CANCELLED') {
    throw new HttpError(400, 'Active E-Way Bill must be cancelled before cancelling the challan');
  }

  const updated = await prisma.deliveryChallan.update({
    where: { id },
    data: { status: 'CANCELLED' },
  });

  res.json(updated);
}

export async function generateChallanEwbHandler(req: Request, res: Response) {
  const { id } = req.params;
  const result = await TaxproService.generateDeliveryChallanEwb(id, req.body || {});
  res.json(result);
}

export async function cancelChallanEwbHandler(req: Request, res: Response) {
  const { id } = req.params;
  const { cancelReason, cancelRemarks } = req.body || {};
  const result = await TaxproService.cancelDeliveryChallanEwb(id, cancelReason || '1', cancelRemarks || 'Cancelled from ERP');
  res.json(result);
}
