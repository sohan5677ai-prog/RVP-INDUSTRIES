import { Request, Response } from 'express';
import { timingSafeEqual, createHmac } from 'crypto';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { logger } from '../lib/logger.js';
import { streamCameraMjpeg, getCameraSnapshotWithMeta, setCameraBroadcast, getCctvStatus } from '../lib/cctvService.js';
import { saveWeighbridgeSnapshot, getLocalSnapshotPath } from '../lib/weighbridgePhotoService.js';
import { calcKataFee, findCompanyVehicle, isVehicleExempt } from '../lib/calc.js';
import { renderWeighbridgeSlipPdf } from '../lib/weighbridgeSlipPdf.js';
import { sendWeighbridgePaidSlip, sendWeighbridgeSecondWeightReminder } from '../services/whatsapp.service.js';
import { recordAutomaticTransfer } from '../services/weighbridgeTransfer.service.js';

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

const STARTING_TICKET_NUMBER = 1;

async function calculateTicketFee(
  netWeightKg: number | null,
  vehicleNumber: string,
  billType: string,
): Promise<number> {
  if (netWeightKg == null || netWeightKg <= 0 || billType.toUpperCase() === 'FREE') return 0;
  const company = await prisma.companyProfile.findFirst({ select: { companyVehicles: true } });
  return calcKataFee(netWeightKg, isVehicleExempt(vehicleNumber, company?.companyVehicles));
}

function paymentStatusFor(amount: number, billType: string): string {
  if (amount <= 0 || billType.toUpperCase() === 'FREE') return 'NOT_REQUIRED';
  return billType.toUpperCase() === 'CREDIT' ? 'CREDIT' : 'PENDING';
}

function slipToken(id: string, paidAt: Date): string {
  const secret = process.env.JWT_SECRET || 'rvp-default-kata-secret-key-2026';
  return createHmac('sha256', secret).update(`weighbridge-slip:${id}:${paidAt.getTime()}`).digest('hex');
}

function readWeight(value: unknown, field: string): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new HttpError(400, `${field} must be greater than 0 kg`);
  }
  return Math.round(parsed);
}

const STORAGE_TRANSFER_LOCATIONS = new Set(['PGR COLD', 'Murugan', 'KNM Multi']);

function resolveStorageTransfer(
  rawEnabled: unknown,
  rawLocation: unknown,
  rawMaterial: unknown,
): { enabled: boolean; storageLocation: string | null; transferDirection: string | null } {
  const enabled = rawEnabled === true || String(rawEnabled).toLowerCase() === 'true';
  if (!enabled) {
    return { enabled: false, storageLocation: null, transferDirection: null };
  }

  const storageLocation = String(rawLocation ?? '').trim();
  if (!STORAGE_TRANSFER_LOCATIONS.has(storageLocation)) {
    throw new HttpError(400, 'Select a valid storage location for this internal transfer');
  }

  const material = String(rawMaterial ?? '').trim().toUpperCase();
  return {
    enabled: true,
    storageLocation,
    transferDirection: (material === 'TAMARIND SEED' || material === 'BLACK SEED') ? 'STORAGE_TO_RVP' : 'RVP_TO_STORAGE',
  };
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
  res.json({
    nextTicketNo: nextNumber,
    formattedTicketNo: String(nextNumber).padStart(2, '0'),
  });
}

/**
 * List weighbridge tickets with search & filters.
 */
export async function getTicketsHandler(req: Request, res: Response) {
  const { search, status, fromDate, toDate, material, movement, sort, limit, all } = req.query;

  const where: any = {};

  if (status && status !== 'ALL') {
    where.status = String(status);
  }

  if (movement === 'TRANSFER') where.isStorageTransfer = true;
  if (movement === 'REGULAR') where.isStorageTransfer = false;

  if (material && material !== 'ALL') {
    where.material = { equals: String(material), mode: 'insensitive' };
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
      const from = new Date(`${String(fromDate)}T00:00:00+05:30`);
      if (Number.isNaN(from.getTime())) throw new HttpError(400, 'Invalid from date');
      where.createdAt.gte = from;
    }
    if (toDate) {
      const to = new Date(`${String(toDate)}T23:59:59.999+05:30`);
      if (Number.isNaN(to.getTime())) throw new HttpError(400, 'Invalid to date');
      where.createdAt.lte = to;
    }
  }

  const take = all === 'true' ? undefined : (limit ? Math.min(Number(limit), 200) : 100);

  const tickets = await prisma.weighbridgeTicket.findMany({
    where,
    orderBy: sort === 'OLDEST'
      ? [{ createdAt: 'asc' }, { ticketNo: 'asc' }]
      : sort === 'COMMODITY'
        ? [{ material: 'asc' }, { createdAt: 'desc' }]
        : [{ createdAt: 'desc' }, { ticketNo: 'desc' }],
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
    isStorageTransfer,
    storageLocation,
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
      const transfer = resolveStorageTransfer(
        Object.prototype.hasOwnProperty.call(req.body, 'isStorageTransfer')
          ? isStorageTransfer
          : existingPending.isStorageTransfer,
        storageLocation ?? existingPending.storageLocation,
        material ?? existingPending.material,
      );
      const secondWeighedAt = new Date();

      await recordAutomaticTransfer({
        ...existingPending,
        material: material ? String(material).trim() : existingPending.material,
        netWeightKg: netWeight,
        isStorageTransfer: transfer.enabled,
        storageLocation: transfer.storageLocation,
        secondWeighedAt,
      });

      const [secondCam1PhotoUrl, secondCam2PhotoUrl] = await Promise.all([
        saveWeighbridgeSnapshot(existingPending.ticketNo, 1, snapCam1, true),
        saveWeighbridgeSnapshot(existingPending.ticketNo, 2, snapCam2, true),
      ]);

      const updated = await prisma.weighbridgeTicket.update({
        where: { id: existingPending.id },
        data: {
          secondWeightKg: secondWeightNum,
          secondWeighedAt,
          netWeightKg: netWeight,
          status: 'COMPLETED',
          tripType: 'SECOND',
          billType: finalBillType,
          amount: finalAmount,
          paymentStatus: paymentStatusFor(finalAmount, finalBillType),
          isStorageTransfer: transfer.enabled,
          storageLocation: transfer.storageLocation,
          transferDirection: transfer.transferDirection,
          partyName: transfer.enabled ? null : (partyName?.trim() || existingPending.partyName),
          ...(partyMobile ? { partyMobile: partyMobile.trim() } : {}),
          ...(material ? { material: material.trim() } : {}),
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
  const transfer = resolveStorageTransfer(isStorageTransfer, storageLocation, material);

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
      partyName: transfer.enabled ? null : (partyName?.trim() || null),
      partyMobile: partyMobile?.trim() || null,
      material: material?.trim() || null,
      loadType: String(loadType).toUpperCase(),
      billType: String(billType).toUpperCase(),
      amount: computedAmount,
      paymentStatus: status === 'COMPLETED' ? paymentStatusFor(computedAmount, String(billType)) : 'NOT_REQUIRED',
      isStorageTransfer: transfer.enabled,
      storageLocation: transfer.storageLocation,
      transferDirection: transfer.transferDirection,
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

  if (ticket.secondWeightKg != null) {
    await recordAutomaticTransfer(ticket);
  }

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
  const { secondWeightKg, secondWeight, partyName, partyMobile, material, loadType, billType, remarks, snapCam1, snapCam2, isStorageTransfer, storageLocation } = req.body;
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
  const transfer = resolveStorageTransfer(
    Object.prototype.hasOwnProperty.call(req.body, 'isStorageTransfer')
      ? isStorageTransfer
      : existing.isStorageTransfer,
    storageLocation ?? existing.storageLocation,
    material ?? existing.material,
  );
  const secondWeighedAt = new Date();

  await recordAutomaticTransfer({
    ...existing,
    material: material ? String(material).trim() : existing.material,
    netWeightKg: netWeight,
    isStorageTransfer: transfer.enabled,
    storageLocation: transfer.storageLocation,
    secondWeighedAt,
  });

  // Capture snapshots for the second weighment
  const [secondCam1PhotoUrl, secondCam2PhotoUrl] = await Promise.all([
    saveWeighbridgeSnapshot(existing.ticketNo, 1, snapCam1, true),
    saveWeighbridgeSnapshot(existing.ticketNo, 2, snapCam2, true),
  ]);

  const updated = await prisma.weighbridgeTicket.update({
    where: { id },
    data: {
      secondWeightKg: secondWeightNum,
      secondWeighedAt,
      netWeightKg: netWeight,
      status: 'COMPLETED',
      tripType: 'SECOND',
      billType: finalBillType,
      amount: finalAmount,
      paymentStatus: paymentStatusFor(finalAmount, finalBillType),
      isStorageTransfer: transfer.enabled,
      storageLocation: transfer.storageLocation,
      transferDirection: transfer.transferDirection,
      partyName: transfer.enabled
        ? null
        : (partyName ? String(partyName).trim() : existing.partyName),
      ...(partyMobile ? { partyMobile: String(partyMobile).trim() } : {}),
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
  const material = String(req.body.material ?? existing.material ?? '').trim();
  const transfer = resolveStorageTransfer(
    Object.prototype.hasOwnProperty.call(req.body, 'isStorageTransfer')
      ? req.body.isStorageTransfer
      : existing.isStorageTransfer,
    req.body.storageLocation ?? existing.storageLocation,
    material,
  );

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
      partyName: transfer.enabled
        ? null
        : (String(req.body.partyName ?? existing.partyName ?? '').trim() || null),
      partyMobile: String(req.body.partyMobile ?? existing.partyMobile ?? '').trim() || null,
      material: material || null,
      loadType: String(req.body.loadType ?? existing.loadType).toUpperCase(),
      billType,
      isStorageTransfer: transfer.enabled,
      storageLocation: transfer.storageLocation,
      transferDirection: transfer.transferDirection,
      firstWeightKg: firstWeight,
      secondWeightKg: secondWeight,
      netWeightKg: netWeight,
      amount,
      paymentStatus: status !== 'COMPLETED'
        ? 'NOT_REQUIRED'
        : existing.paymentStatus === 'PAID' && amount > 0
          ? 'PAID'
          : paymentStatusFor(amount, billType),
      status,
      firstWeighedAt: firstWeight != null ? (existing.firstWeighedAt ?? new Date()) : null,
      secondWeighedAt: secondWeight != null ? (existing.secondWeighedAt ?? new Date()) : null,
      remarks: String(req.body.remarks ?? existing.remarks ?? '').trim() || null,
    },
  });

  res.json(updated);
}

/** Remind both the driver and Hamali Team that this vehicle is awaiting its second weight. */
export async function remindSecondWeightHandler(req: Request, res: Response) {
  const ticket = await prisma.weighbridgeTicket.findUnique({ where: { id: req.params.id } });
  if (!ticket) throw new HttpError(404, 'Weighbridge ticket not found');
  if (ticket.status !== 'PENDING_SECOND') throw new HttpError(400, 'This ticket is no longer awaiting second weight');

  const hamali = await prisma.party.findFirst({ where: { type: 'HAMALI_TEAM' }, select: { name: true, phone: true, phone2: true } });
  const recipients = [
    ticket.partyMobile ? { phone: ticket.partyMobile, label: 'Driver' } : null,
    hamali?.phone ? { phone: hamali.phone, label: hamali.name || 'Hamali Team' } : null,
    hamali?.phone2 ? { phone: hamali.phone2, label: hamali.name || 'Hamali Team' } : null,
  ].filter((v): v is { phone: string; label: string } => Boolean(v?.phone));
  if (!recipients.length) throw new HttpError(400, 'Add the driver mobile or Hamali Team phone number before sending a reminder');

  const results = await Promise.all(recipients.map((recipient) => sendWeighbridgeSecondWeightReminder({
    to: recipient.phone,
    recipientLabel: recipient.label,
    ticketId: ticket.id,
    ticketNo: ticket.ticketNo,
    vehicleNumber: ticket.vehicleNumber,
    firstWeightKg: ticket.firstWeightKg || 0,
    firstWeighedAt: ticket.firstWeighedAt,
  })));
  const sent = results.filter((result) => result.ok).length;
  if (sent > 0) {
    await prisma.weighbridgeTicket.update({ where: { id: ticket.id }, data: { secondWeightReminderSentAt: new Date() } });
  }
  res.json({ sent, attempted: recipients.length, results });
}

/** Verify counter payment, persist its audit trail, and WhatsApp the signed Kata slip to the driver. */
export async function verifyTicketPaymentHandler(req: Request, res: Response) {
  const ticket = await prisma.weighbridgeTicket.findUnique({ where: { id: req.params.id } });
  if (!ticket) throw new HttpError(404, 'Weighbridge ticket not found');
  if (ticket.status !== 'COMPLETED') throw new HttpError(400, 'Complete the second weight before verifying payment');
  if (ticket.paymentStatus === 'PAID') throw new HttpError(400, 'Payment is already verified');

  const due = Number(ticket.amount || 0);
  const received = req.body.amount == null ? due : Number(req.body.amount);
  if (!Number.isFinite(received) || received < 0) throw new HttpError(400, 'Payment amount must be zero or greater');
  if (due > 0 && received !== due) throw new HttpError(400, `Payment must match the Kata charge of Rs. ${due}`);

  const paidAt = new Date();
  const user = (req as any).user;
  let updated = await prisma.weighbridgeTicket.update({
    where: { id: ticket.id },
    data: {
      paymentStatus: due > 0 ? 'PAID' : 'NOT_REQUIRED',
      paidAmount: received,
      paidAt,
      paymentVerifiedBy: user?.name || user?.email || 'Kata Operator',
      paymentReference: String(req.body.reference || (due > 0 ? 'CASH' : 'FREE')).trim().slice(0, 100),
    },
  });

  let whatsapp: { ok: boolean; skipped?: boolean; error?: string } = { ok: false, skipped: true, error: 'Driver mobile is missing' };
  if (updated.partyMobile) {
    const company = await prisma.companyProfile.findFirst({ select: { companyVehicles: true } });
    const driver = findCompanyVehicle(updated.vehicleNumber, company?.companyVehicles);
    const token = slipToken(updated.id, paidAt);
    const apiBase = (process.env.PUBLIC_API_BASE_URL || 'https://rvp-server.onrender.com/api').replace(/\/$/, '');
    const url = `${apiBase}/weighbridge/tickets/${updated.id}/slip.pdf?token=${token}`;
    whatsapp = await sendWeighbridgePaidSlip({
      to: updated.partyMobile,
      driverName: driver?.driverName || 'Driver',
      ticketId: updated.id,
      ticketNo: updated.ticketNo,
      vehicleNumber: updated.vehicleNumber,
      netWeightKg: updated.netWeightKg || 0,
      amount: received,
      slipUrl: url,
    });
    if (whatsapp.ok) {
      updated = await prisma.weighbridgeTicket.update({ where: { id: updated.id }, data: { slipWhatsappSentAt: new Date() } });
    }
  }
  res.json({ ticket: updated, whatsapp });
}

/** Public, unguessable document URL consumed by WhatsApp's media fetcher. */
export async function downloadSignedWeighbridgeSlipHandler(req: Request, res: Response) {
  const ticket = await prisma.weighbridgeTicket.findUnique({ where: { id: req.params.id } });
  if (!ticket || !ticket.paidAt) throw new HttpError(404, 'Signed Kata slip not found');
  const expected = slipToken(ticket.id, ticket.paidAt);
  const received = String(req.query.token || '');
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(403, 'Invalid slip link');
  const company = await prisma.companyProfile.findFirst({ select: { name: true, address: true, gstin: true, contact: true } });
  const pdf = await renderWeighbridgeSlipPdf(ticket, company || { name: 'RVP INDUSTRIES', address: null, gstin: null, contact: null });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Kata-Slip-${String(ticket.ticketNo).padStart(2, '0')}.pdf"`);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.send(pdf);
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

  const [stockTransfer, huskTransfer, byproductTransfer] = await Promise.all([
    prisma.stockTransfer.findUnique({ where: { weighbridgeTicketId: id }, select: { id: true } }),
    prisma.huskTransfer.findUnique({ where: { weighbridgeTicketId: id }, select: { id: true } }),
    prisma.shellTransfer.findUnique({ where: { weighbridgeTicketId: id }, select: { id: true } }),
  ]);
  if (stockTransfer || huskTransfer || byproductTransfer) {
    throw new HttpError(409, 'Reverse the linked automatic transfer before deleting this Kata ticket');
  }

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
  const requestedBy = req.body.requestedBy || user?.name || (isTrustedCameraBridge(req) ? 'CABIN_BRIDGE' : 'REMOTE');

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
