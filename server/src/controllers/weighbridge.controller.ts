import { Request, Response } from 'express';
import { timingSafeEqual, createHmac } from 'crypto';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { logger } from '../lib/logger.js';
import { streamCameraMjpeg, getCameraSnapshotWithMeta, setCameraBroadcast, getCctvStatus } from '../lib/cctvService.js';
import { saveWeighbridgeSnapshot, getLocalSnapshotPath } from '../lib/weighbridgePhotoService.js';
import { calcKataFee, isVehicleExempt } from '../lib/calc.js';

function getExpectedBridgeKey(): string {
  if (process.env.CCTV_BRIDGE_KEY && process.env.CCTV_BRIDGE_KEY.length >= 24) {
    return process.env.CCTV_BRIDGE_KEY;
  }
  const secret = process.env.JWT_SECRET || 'rvp-default-kata-secret-key-2026';
  return createHmac('sha256', secret).update('rvp-cctv-bridge-v1').digest('hex');
}

export function isTrustedCameraBridge(req: Request): boolean {
  const expected = getExpectedBridgeKey();
  const received = req.header('x-cctv-bridge-key');
  if (!received || received.length < 24) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const STARTING_TICKET_NUMBER = 2807;

async function calculateTicketFee(
  netWeightKg: number | null,
  vehicleNumber: string,
  billType: string,
): Promise<number> {
  if (netWeightKg == null || netWeightKg <= 0 || billType.toUpperCase() === 'FREE') return 0;
  const company = await prisma.companyProfile.findFirst({ select: { companyVehicles: true } });
  return calcKataFee(netWeightKg, isVehicleExempt(vehicleNumber, company?.companyVehicles));
}

function readWeight(value: unknown, field: string): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new HttpError(400, `${field} must be greater than 0 kg`);
  }
  return Math.round(parsed);
}

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
  const { search, status, fromDate, toDate, limit, all } = req.query;

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

  const take = all === 'true' ? undefined : (limit ? Math.min(Number(limit), 200) : 100);

  const tickets = await prisma.weighbridgeTicket.findMany({
    where,
    orderBy: { ticketNo: 'desc' },
    take,
  });

  res.json(tickets);
}

function normaliseMatchText(value: string): string {
  return value.toUpperCase().replace(/&/g, 'AND').replace(/[^A-Z0-9]/g, '');
}

/**
 * Resolve the physical Kata ticket for an ERP movement. Date + lorry are used
 * in the database lookup; party is then compared after stripping punctuation
 * and spacing so entries such as "ABC & Co." and "ABC AND CO" remain usable.
 */
export async function matchTicketHandler(req: Request, res: Response) {
  const date = String(req.query.date ?? '').trim();
  const vehicleNumber = normaliseMatchText(String(req.query.vehicleNumber ?? ''));
  const partyName = normaliseMatchText(String(req.query.partyName ?? ''));

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !vehicleNumber || !partyName) {
    throw new HttpError(400, 'Date, party name and vehicle number are required');
  }

  // ERP dates are India-local business dates even when the server runs in UTC.
  const start = new Date(`${date}T00:00:00+05:30`);
  const end = new Date(`${date}T23:59:59.999+05:30`);
  const candidates = await prisma.weighbridgeTicket.findMany({
    where: {
      createdAt: { gte: start, lte: end },
      status: { not: 'CANCELLED' },
    },
    orderBy: [{ updatedAt: 'desc' }, { ticketNo: 'desc' }],
  });

  const matched = candidates.find((ticket) =>
    normaliseMatchText(ticket.vehicleNumber) === vehicleNumber
    && normaliseMatchText(ticket.partyName ?? '') === partyName,
  ) ?? null;

  res.json(matched);
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

  const firstWeight = readWeight(firstWeightKg ?? req.body.firstWeight, 'First weight');
  const secondWeight = readWeight(secondWeightKg ?? req.body.secondWeight, 'Second weight');

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
      if (netWeight <= 0) throw new HttpError(400, 'First and second weights must be different');
      const finalBillType = String(billType || existingPending.billType || 'CASH').toUpperCase();
      const finalAmount = await calculateTicketFee(netWeight, cleanVehNo, finalBillType);

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
          billType: finalBillType,
          amount: finalAmount,
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
  const computedAmount = status === 'COMPLETED'
    ? await calculateTicketFee(netWeight, cleanVehNo, String(billType))
    : 0;

  const user = (req as any).user;
  const operatorName = user?.name || (user?.scope === 'KATA_CABIN' ? 'Kata Cabin' : 'ADMIN');

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
      amount: computedAmount,
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

  // Auto-queue print job for the cabin printer (fire-and-forget)
  prisma.printJob.create({
    data: {
      ticketId: ticket.id,
      ticketNo: ticket.ticketNo,
      requestedBy: 'AUTO',
      status: 'PENDING',
    },
  }).catch((err: any) => logger.warn('[weighbridge] Auto-queue print job failed:', err.message));
}

/**
 * Complete second weight for an existing pending ticket.
 */
export async function completeSecondWeightHandler(req: Request, res: Response) {
  const { id } = req.params;
  const { secondWeightKg, secondWeight, partyName, material, loadType, billType, remarks, snapCam1, snapCam2 } = req.body;
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
  if (netWeight <= 0) throw new HttpError(400, 'First and second weights must be different');
  const finalBillType = String(billType || existing.billType || 'CASH').toUpperCase();
  const finalAmount = await calculateTicketFee(netWeight, existing.vehicleNumber, finalBillType);

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
      billType: finalBillType,
      amount: finalAmount,
      ...(partyName ? { partyName: String(partyName).trim() } : {}),
      ...(material ? { material: String(material).trim() } : {}),
      ...(loadType ? { loadType: String(loadType).toUpperCase() } : {}),
      ...(remarks ? { remarks: remarks.trim() } : {}),
      secondCam1PhotoUrl,
      secondCam2PhotoUrl,
    },
  });

  res.json(updated);

  // Auto-queue print job for the completed ticket (fire-and-forget)
  prisma.printJob.create({
    data: {
      ticketId: updated.id,
      ticketNo: updated.ticketNo,
      requestedBy: 'AUTO',
      status: 'PENDING',
    },
  }).catch((err: any) => logger.warn('[weighbridge] Auto-queue print job failed:', err.message));
}

/**
 * Correct a saved ticket from the Ticket Register. Weight corrections always
 * recompute net weight and the kata fee so the register, counter display and
 * printed slip cannot disagree.
 */
export async function updateTicketHandler(req: Request, res: Response) {
  const { id } = req.params;
  const existing = await prisma.weighbridgeTicket.findUnique({ where: { id } });
  if (!existing) throw new HttpError(404, 'Weighbridge ticket not found');

  const vehicleNumber = String(req.body.vehicleNumber ?? existing.vehicleNumber).trim().toUpperCase();
  if (!vehicleNumber) throw new HttpError(400, 'Vehicle number is required');

  const firstWeight = readWeight(
    Object.prototype.hasOwnProperty.call(req.body, 'firstWeightKg') ? req.body.firstWeightKg : existing.firstWeightKg,
    'First weight',
  );
  const secondWeight = readWeight(
    Object.prototype.hasOwnProperty.call(req.body, 'secondWeightKg') ? req.body.secondWeightKg : existing.secondWeightKg,
    'Second weight',
  );
  const tripType = String(req.body.tripType ?? existing.tripType).toUpperCase();
  const billType = String(req.body.billType ?? existing.billType).toUpperCase();

  let netWeight: number | null = null;
  let status = existing.status;
  if (firstWeight != null && secondWeight != null) {
    netWeight = Math.abs(firstWeight - secondWeight);
    if (netWeight <= 0) throw new HttpError(400, 'First and second weights must be different');
    status = 'COMPLETED';
  } else if (tripType === 'SINGLE' && firstWeight != null) {
    netWeight = firstWeight;
    status = 'COMPLETED';
  } else {
    status = 'PENDING_SECOND';
  }

  const amount = status === 'COMPLETED'
    ? await calculateTicketFee(netWeight, vehicleNumber, billType)
    : 0;

  const updated = await prisma.weighbridgeTicket.update({
    where: { id },
    data: {
      vehicleNumber,
      vehicleType: String(req.body.vehicleType ?? existing.vehicleType).toUpperCase(),
      tripType,
      partyName: String(req.body.partyName ?? existing.partyName ?? '').trim() || null,
      partyMobile: String(req.body.partyMobile ?? existing.partyMobile ?? '').trim() || null,
      material: String(req.body.material ?? existing.material ?? '').trim() || null,
      loadType: String(req.body.loadType ?? existing.loadType).toUpperCase(),
      billType,
      firstWeightKg: firstWeight,
      secondWeightKg: secondWeight,
      netWeightKg: netWeight,
      amount,
      status,
      firstWeighedAt: firstWeight != null ? (existing.firstWeighedAt ?? new Date()) : null,
      secondWeighedAt: secondWeight != null ? (existing.secondWeighedAt ?? new Date()) : null,
      remarks: String(req.body.remarks ?? existing.remarks ?? '').trim() || null,
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

/** Permanently remove a register entry and its queued print jobs. */
export async function deleteTicketHandler(req: Request, res: Response) {
  const { id } = req.params;
  const existing = await prisma.weighbridgeTicket.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw new HttpError(404, 'Weighbridge ticket not found');

  await prisma.$transaction([
    prisma.printJob.deleteMany({ where: { ticketId: id } }),
    prisma.weighbridgeTicket.delete({ where: { id } }),
  ]);
  res.status(204).send();
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
    const frame = await getCameraSnapshotWithMeta(camNum);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'X-Frame-Timestamp, X-Frame-Source');
    res.setHeader('X-Frame-Timestamp', String(frame.timestamp));
    res.setHeader('X-Frame-Source', frame.source);
    res.send(frame.buffer);
  } catch (err: any) {
    res.status(502).json({ error: err.message || 'Snapshot failed' });
  }
}

/**
 * Ingest live CCTV camera frame broadcast from Kata Cabin bridge.
 */
export async function broadcastCctvHandler(req: Request, res: Response) {
  if (!isTrustedCameraBridge(req)) {
    throw new HttpError(401, 'Untrusted CCTV bridge');
  }
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
      error: error ? String(error) : undefined,
    });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.json({ success: true, reading: service.getReading() });
}

// =====================================================================
// Print Queue Handlers (for Remote Cabin Printing)
// =====================================================================

/**
 * Queue a ticket for printing on the cabin printer.
 */
export async function queuePrintJobHandler(req: Request, res: Response) {
  if (!isTrustedCameraBridge(req) && !(req as any).user) {
    throw new HttpError(401, 'Unauthorized');
  }

  const { ticketId, ticketNo } = req.body;
  if (!ticketId || !ticketNo) {
    throw new HttpError(400, 'ticketId and ticketNo are required');
  }

  const user = (req as any).user;
  const requestedBy = user?.name || (isTrustedCameraBridge(req) ? 'CABIN_BRIDGE' : 'REMOTE');

  const job = await prisma.printJob.create({
    data: {
      ticketId: String(ticketId),
      ticketNo: Number(ticketNo),
      requestedBy,
      status: 'PENDING',
    },
  });

  res.status(201).json(job);
}

let lastPrintAgentPollAt: number | null = null;
let lastPrintAgentPrinter: string | null = null;
let lastPrintAgentReady: boolean | null = null;
let lastPrintAgentError: string | null = null;

function decodePrintAgentHeader(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value).slice(0, 500);
  } catch {
    return value.slice(0, 500);
  }
}

/**
 * Fetch pending print jobs for the cabin agent to process.
 * The agent polls this endpoint every few seconds.
 */
export async function getPendingPrintJobsHandler(req: Request, res: Response) {
  if (!isTrustedCameraBridge(req) && !(req as any).user) {
    throw new HttpError(401, 'Unauthorized print agent');
  }

  if (isTrustedCameraBridge(req)) {
    lastPrintAgentPollAt = Date.now();
    lastPrintAgentPrinter = decodePrintAgentHeader(req.get('X-Print-Agent-Printer'));
    const readyHeader = req.get('X-Print-Agent-Ready');
    lastPrintAgentReady = readyHeader == null ? null : readyHeader === 'true';
    lastPrintAgentError = decodePrintAgentHeader(req.get('X-Print-Agent-Error'));
  }

  const jobs = await prisma.printJob.findMany({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    take: 10,
  });

  // For each job, also fetch the full ticket data so the agent can print it
  const enriched = await Promise.all(
    jobs.map(async (job) => {
      const ticket = await prisma.weighbridgeTicket.findUnique({
        where: { id: job.ticketId },
      });
      return { ...job, ticket };
    })
  );

  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.json(enriched);
}

/**
 * Cabin agent marks a print job as completed or failed.
 */
export async function completePrintJobHandler(req: Request, res: Response) {
  if (!isTrustedCameraBridge(req) && !(req as any).user) {
    throw new HttpError(401, 'Unauthorized print agent');
  }

  const { id } = req.params;
  const { status, error } = req.body;

  if (!['COMPLETED', 'FAILED'].includes(status)) {
    throw new HttpError(400, 'status must be COMPLETED or FAILED');
  }

  const updated = await prisma.printJob.update({
    where: { id },
    data: {
      status,
      completedAt: new Date(),
      error: error || null,
    },
  });

  res.json(updated);
}

/**
 * Check cabin print agent health (has it polled recently?)
 */
export async function getPrintAgentStatusHandler(_req: Request, res: Response) {
  // Find the most recently completed print job
  const lastCompleted = await prisma.printJob.findFirst({
    where: { status: { in: ['COMPLETED', 'FAILED'] } },
    orderBy: { completedAt: 'desc' },
    select: { completedAt: true, status: true, ticketNo: true },
  });

  // Count pending jobs
  const pendingCount = await prisma.printJob.count({
    where: { status: 'PENDING' },
  });

  const isPollingRecently = lastPrintAgentPollAt != null && Date.now() - lastPrintAgentPollAt < 30_000;
  res.json({
    lastActivity: lastCompleted?.completedAt || (lastPrintAgentPollAt ? new Date(lastPrintAgentPollAt) : null),
    lastTicketNo: lastCompleted?.ticketNo || null,
    lastStatus: lastCompleted?.status || null,
    pendingCount,
    // A historical completion must not make a stopped agent look online.
    agentOnline: isPollingRecently,
    printerName: isPollingRecently ? lastPrintAgentPrinter : null,
    printerReady: isPollingRecently ? lastPrintAgentReady : false,
    printerError: isPollingRecently ? lastPrintAgentError : 'Cabin print agent is offline.',
  });
}
