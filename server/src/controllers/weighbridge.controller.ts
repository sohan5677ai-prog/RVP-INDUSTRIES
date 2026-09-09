import { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { streamCameraMjpeg, getCameraSnapshot } from '../lib/cctvService.js';

const STARTING_TICKET_NUMBER = 2807;

/**
 * Get next sequential weighbridge ticket number.
 */
export async function getNextTicketNumberHandler(_req: Request, res: Response) {
  const latest = await prisma.weighbridgeTicket.findFirst({
    orderBy: { ticketNo: 'desc' },
    select: { ticketNo: true },
  });

  const nextNumber = latest ? latest.ticketNo + 1 : STARTING_TICKET_NUMBER;
  res.json({ nextTicketNo: nextNumber });
}

/**
 * List weighbridge tickets with search & filters.
 */
export async function getTicketsHandler(req: Request, res: Response) {
  const { search, status, fromDate, toDate, limit } = req.query;

  const where: any = {};

  if (status && status !== 'ALL') {
    where.status = String(status);
  }

  if (search) {
    const q = String(search).trim();
    where.OR = [
      { vehicleNumber: { contains: q, mode: 'insensitive' } },
      { partyName: { contains: q, mode: 'insensitive' } },
      { material: { contains: q, mode: 'insensitive' } },
      ...(isNaN(Number(q)) ? [] : [{ ticketNo: Number(q) }]),
    ];
  }

  if (fromDate || toDate) {
    where.createdAt = {};
    if (fromDate) {
      const from = new Date(String(fromDate));
      from.setHours(0, 0, 0, 0);
      where.createdAt.gte = from;
    }
    if (toDate) {
      const to = new Date(String(toDate));
      to.setHours(23, 59, 59, 999);
      where.createdAt.lte = to;
    }
  }

  const take = limit ? Math.min(Number(limit), 200) : 100;

  const tickets = await prisma.weighbridgeTicket.findMany({
    where,
    orderBy: { ticketNo: 'desc' },
    take,
  });

  res.json(tickets);
}

/**
 * List pending trucks (completed first weight, awaiting second weight).
 */
export async function getPendingSecondWeightHandler(_req: Request, res: Response) {
  const pending = await prisma.weighbridgeTicket.findMany({
    where: { status: 'PENDING_SECOND' },
    orderBy: { createdAt: 'desc' },
  });
  res.json(pending);
}

/**
 * Create a new weighbridge ticket.
 */
export async function createTicketHandler(req: Request, res: Response) {
  const {
    vehicleNumber,
    vehicleType = 'LORRY',
    tripType = 'SECOND',
    partyName,
    partyMobile,
    material,
    loadType = 'LOAD',
    billType = 'CASH',
    amount = 100,
    firstWeightKg,
    secondWeightKg,
    netWeightKg: providedNet,
    remarks,
  } = req.body;

  if (!vehicleNumber?.trim()) {
    throw new HttpError(400, 'Vehicle number is required');
  }

  const cleanVehNo = vehicleNumber.trim().toUpperCase();

  // Compute next sequential ticket number atomically
  const latest = await prisma.weighbridgeTicket.findFirst({
    orderBy: { ticketNo: 'desc' },
    select: { ticketNo: true },
  });
  const ticketNo = latest ? latest.ticketNo + 1 : STARTING_TICKET_NUMBER;

  const firstWeight = firstWeightKg != null ? Number(firstWeightKg) : null;
  const secondWeight = secondWeightKg != null ? Number(secondWeightKg) : null;

  let netWeight: number | null = null;
  if (firstWeight != null && secondWeight != null) {
    netWeight = Math.abs(secondWeight - firstWeight);
  } else if (providedNet != null) {
    netWeight = Number(providedNet);
  }

  const isPending = tripType === 'FIRST' && secondWeight == null;
  const status = isPending ? 'PENDING_SECOND' : 'COMPLETED';

  const user = (req as any).user;
  const operatorName = user?.name || 'ADMIN';

  const ticket = await prisma.weighbridgeTicket.create({
    data: {
      ticketNo,
      vehicleNumber: cleanVehNo,
      vehicleType: String(vehicleType).toUpperCase(),
      tripType: String(tripType).toUpperCase(),
      partyName: partyName?.trim() || null,
      partyMobile: partyMobile?.trim() || null,
      material: material?.trim() || null,
      loadType: String(loadType).toUpperCase(),
      billType: String(billType).toUpperCase(),
      amount: Number(amount) || 100,
      firstWeightKg: firstWeight,
      secondWeightKg: secondWeight,
      netWeightKg: netWeight,
      firstWeighedAt: firstWeight != null ? new Date() : null,
      secondWeighedAt: secondWeight != null ? new Date() : null,
      status,
      operatorName,
      remarks: remarks?.trim() || null,
    },
  });

  res.status(201).json(ticket);
}

/**
 * Complete second weight for an existing pending ticket.
 */
export async function completeSecondWeightHandler(req: Request, res: Response) {
  const { id } = req.params;
  const { secondWeightKg, loadType, remarks } = req.body;

  if (secondWeightKg == null || isNaN(Number(secondWeightKg))) {
    throw new HttpError(400, 'Second weight (kg) is required');
  }

  const existing = await prisma.weighbridgeTicket.findUnique({
    where: { id },
  });

  if (!existing) {
    throw new HttpError(404, 'Weighbridge ticket not found');
  }

  const secondWeight = Number(secondWeightKg);
  const firstWeight = existing.firstWeightKg ?? 0;
  const netWeight = Math.abs(secondWeight - firstWeight);

  const updated = await prisma.weighbridgeTicket.update({
    where: { id },
    data: {
      secondWeightKg: secondWeight,
      secondWeighedAt: new Date(),
      netWeightKg: netWeight,
      status: 'COMPLETED',
      tripType: 'SECOND',
      ...(loadType ? { loadType: String(loadType).toUpperCase() } : {}),
      ...(remarks ? { remarks: remarks.trim() } : {}),
    },
  });

  res.json(updated);
}

/**
 * Cancel a ticket.
 */
export async function cancelTicketHandler(req: Request, res: Response) {
  const { id } = req.params;

  const updated = await prisma.weighbridgeTicket.update({
    where: { id },
    data: { status: 'CANCELLED' },
  });

  res.json(updated);
}

/**
 * Stream live continuous MJPEG video from CP PLUS CCTV camera.
 */
export async function streamCctvHandler(req: Request, res: Response) {
  const camNum = req.query.cam === '2' ? 2 : 1;
  await streamCameraMjpeg(camNum, res);
}

/**
 * Capture single high-res JPEG snapshot from CP PLUS CCTV camera.
 */
export async function snapshotCctvHandler(req: Request, res: Response) {
  const camNum = req.query.cam === '2' ? 2 : 1;
  try {
    const buf = await getCameraSnapshot(camNum);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(buf);
  } catch (err: any) {
    res.status(502).json({ error: err.message || 'Snapshot failed' });
  }
}
