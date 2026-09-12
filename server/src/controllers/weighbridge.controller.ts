import { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { logger } from '../lib/logger.js';
import { streamCameraMjpeg, getCameraSnapshot, setCameraBroadcast, getCctvStatus } from '../lib/cctvService.js';
import { saveWeighbridgeSnapshot, getLocalSnapshotPath } from '../lib/weighbridgePhotoService.js';

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
    snapCam1,
    snapCam2,
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

  const firstWeight = firstWeightKg != null ? Number(firstWeightKg) : (req.body.firstWeight != null ? Number(req.body.firstWeight) : null);
  const secondWeight = secondWeightKg != null ? Number(secondWeightKg) : (req.body.secondWeight != null ? Number(req.body.secondWeight) : null);

  // If operator is submitting 2nd weight on an existing pending ticket
  if (tripType === 'SECOND') {
    const existingPending = await prisma.weighbridgeTicket.findFirst({
      where: { vehicleNumber: cleanVehNo, status: 'PENDING_SECOND' },
      orderBy: { createdAt: 'desc' },
    });
    if (existingPending) {
      const secondWeightNum = Number(secondWeight ?? firstWeight ?? 0);
      const firstWeightExisting = existingPending.firstWeightKg ?? 0;
      const netWeight = Math.abs(secondWeightNum - firstWeightExisting);

      const [secondCam1PhotoUrl, secondCam2PhotoUrl] = await Promise.all([
        saveWeighbridgeSnapshot(existingPending.ticketNo, 1, snapCam1, true),
        saveWeighbridgeSnapshot(existingPending.ticketNo, 2, snapCam2, true),
      ]);

      const updated = await prisma.weighbridgeTicket.update({
        where: { id: existingPending.id },
        data: {
          secondWeightKg: secondWeightNum,
          secondWeighedAt: new Date(),
          netWeightKg: netWeight,
          status: 'COMPLETED',
          tripType: 'SECOND',
          ...(loadType ? { loadType: String(loadType).toUpperCase() } : {}),
          ...(remarks ? { remarks: remarks.trim() } : {}),
          secondCam1PhotoUrl,
          secondCam2PhotoUrl,
        },
      });
      return res.status(200).json(updated);
    }
  }

  let netWeight: number | null = null;
  if (firstWeight != null && secondWeight != null) {
    netWeight = Math.abs(secondWeight - firstWeight);
  } else if (providedNet != null) {
    netWeight = Number(providedNet);
  } else if (firstWeight != null) {
    // For first weighment (or single weighment), net weight defaults to first weight
    netWeight = firstWeight;
  }

  const isPending = tripType === 'FIRST' && secondWeight == null;
  const status = isPending ? 'PENDING_SECOND' : 'COMPLETED';

  const user = (req as any).user;
  const operatorName = user?.name || 'ADMIN';

  // Capture and persist CCTV snapshots taken during this kata weighment
  const [cam1PhotoUrl, cam2PhotoUrl] = await Promise.all([
    saveWeighbridgeSnapshot(ticketNo, 1, snapCam1, false),
    saveWeighbridgeSnapshot(ticketNo, 2, snapCam2, false),
  ]);

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
      cam1PhotoUrl,
      cam2PhotoUrl,
    },
  });

  res.status(201).json(ticket);
}

/**
 * Complete second weight for an existing pending ticket.
 */
export async function completeSecondWeightHandler(req: Request, res: Response) {
  const { id } = req.params;
  const { secondWeightKg, secondWeight, partyName, material, amount, loadType, remarks, snapCam1, snapCam2 } = req.body;
  const weightVal = secondWeightKg ?? secondWeight ?? req.body.weight ?? req.body.liveWeight;

  if (weightVal == null || isNaN(Number(weightVal))) {
    logger.warn(`Second weight missing or invalid in completeSecondWeightHandler (id=${id})`, req.body);
    throw new HttpError(400, 'Second weight (kg) is required');
  }

  const existing = await prisma.weighbridgeTicket.findUnique({
    where: { id },
  });

  if (!existing) {
    throw new HttpError(404, 'Weighbridge ticket not found');
  }

  const secondWeightNum = Number(weightVal);
  const firstWeight = existing.firstWeightKg ?? 0;
  const netWeight = Math.abs(secondWeightNum - firstWeight);

  // Capture snapshots for the second weighment
  const [secondCam1PhotoUrl, secondCam2PhotoUrl] = await Promise.all([
    saveWeighbridgeSnapshot(existing.ticketNo, 1, snapCam1, true),
    saveWeighbridgeSnapshot(existing.ticketNo, 2, snapCam2, true),
  ]);

  const updated = await prisma.weighbridgeTicket.update({
    where: { id },
    data: {
      secondWeightKg: secondWeightNum,
      secondWeighedAt: new Date(),
      netWeightKg: netWeight,
      status: 'COMPLETED',
      tripType: 'SECOND',
      ...(partyName ? { partyName: String(partyName).trim() } : {}),
      ...(material ? { material: String(material).trim() } : {}),
      ...(amount != null && !isNaN(Number(amount)) ? { amount: Number(amount) } : {}),
      ...(loadType ? { loadType: String(loadType).toUpperCase() } : {}),
      ...(remarks ? { remarks: remarks.trim() } : {}),
      secondCam1PhotoUrl,
      secondCam2PhotoUrl,
    },
  });

  res.json(updated);
}

/**
 * Serve locally stored weighbridge snapshot files.
 */
export async function getStoredSnapshotHandler(req: Request, res: Response) {
  const { filename } = req.params;
  const filePath = getLocalSnapshotPath(filename);
  if (!filePath) {
    res.status(404).send('Snapshot not found');
    return;
  }
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(filePath);
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
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(buf);
  } catch (err: any) {
    res.status(502).json({ error: err.message || 'Snapshot failed' });
  }
}

/**
 * Ingest live CCTV camera frame broadcast from Kata Cabin bridge.
 */
export async function broadcastCctvHandler(req: Request, res: Response) {
  const { cam, image } = req.body;
  const camNum = cam === 2 || cam === '2' ? 2 : 1;
  if (!image || typeof image !== 'string') {
    throw new HttpError(400, 'Base64 image string is required');
  }

  const cleanBase64 = image.replace(/^data:image\/\w+;base64,/, '');
  const buf = Buffer.from(cleanBase64, 'base64');
  if (buf.length < 200) {
    throw new HttpError(400, 'Invalid image buffer size');
  }

  setCameraBroadcast(camNum, buf);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.json({ success: true, cam: camNum, size: buf.length, timestamp: Date.now() });
}

/**
 * Diagnostic status endpoint for cameras & bridge health.
 */
export async function getCctvStatusHandler(_req: Request, res: Response) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.json(getCctvStatus());
}

/**
 * Get instant snapshot of current scale weight from COM port.
 */
export async function getLiveScaleHandler(_req: Request, res: Response) {
  const { getServerScaleService } = await import('../lib/serverScaleService.js');
  const service = getServerScaleService();
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json(service.getReading());
}

/**
 * Server-Sent Events (SSE) stream for sub-50ms real-time live weight broadcasting.
 */
export async function streamLiveScaleHandler(req: Request, res: Response) {
  const { getServerScaleService } = await import('../lib/serverScaleService.js');
  const service = getServerScaleService();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const unsubscribe = service.subscribe((reading) => {
    res.write(`data: ${JSON.stringify(reading)}\n\n`);
  });

  req.on('close', () => {
    unsubscribe();
  });
}

/**
 * List all available COM serial ports on Windows machine.
 */
export async function listScalePortsHandler(_req: Request, res: Response) {
  const { getServerScaleService } = await import('../lib/serverScaleService.js');
  const service = getServerScaleService();
  const ports = await service.listPorts();
  res.json({
    activePort: service.getPortName(),
    activeBaudRate: service.getBaudRate(),
    reading: service.getReading(),
    ports,
  });
}

/**
 * Dynamically reconfigure COM port or baud rate.
 */
export async function configScalePortHandler(req: Request, res: Response) {
  const { port, baudRate } = req.body;
  if (!port) {
    throw new HttpError(400, 'Port name is required (e.g. COM4)');
  }
  const { getServerScaleService } = await import('../lib/serverScaleService.js');
  const service = getServerScaleService();
  await service.setConfig(String(port), baudRate ? Number(baudRate) : undefined);
  res.json({ success: true, reading: service.getReading() });
}

/**
 * Broadcast live scale weight pushed from a terminal (e.g. Kata Cabin via Web Serial).
 */
export async function broadcastScaleReadingHandler(req: Request, res: Response) {
  const { liveWeight, isStable, rawText, port, isConnected, error } = req.body;
  const { getServerScaleService } = await import('../lib/serverScaleService.js');
  const service = getServerScaleService();

  if (isConnected === false) {
    service.reportClientDisconnect(error);
  } else {
    service.updateClientReading({
      liveWeight: Number(liveWeight),
      isStable: !!isStable,
      rawText: rawText ? String(rawText) : undefined,
      port: port ? String(port) : undefined,
    });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.json({ success: true, reading: service.getReading() });
}

