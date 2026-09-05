import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import {
  getMaintenanceStatus,
  getMaintenanceConfigRecord,
  updateMaintenanceConfig,
  extendMaintenanceDuration,
  endMaintenanceMode,
} from '../services/maintenance.service.js';

export async function clearTransactions(_req: Request, res: Response) {
  await prisma.$transaction([
    prisma.saleAllocation.deleteMany(),
    prisma.weightVerification.deleteMany(),
    prisma.purchase.deleteMany(),
    prisma.stockIn.deleteMany(),
    prisma.stockTransfer.deleteMany(),
    prisma.purchaseOrder.deleteMany(),
    prisma.saleDispatch.deleteMany(),
    prisma.saleOrder.deleteMany(),
    prisma.journalLine.deleteMany(),
    prisma.journalEntry.deleteMany(),
    prisma.siloInventory.deleteMany(),
  ]);
  res.json({ message: 'All transactional data, ledger logs, and inventory balances have been cleared. You are starting fresh!' });
}

/**
 * Public status endpoint: Returns live maintenance status & countdown timer
 */
export async function getMaintenanceStatusHandler(_req: Request, res: Response) {
  const status = await getMaintenanceStatus();
  res.json(status);
}

/**
 * Developer-only: Get full maintenance configuration
 */
export async function getMaintenanceConfigHandler(_req: Request, res: Response) {
  const config = await getMaintenanceConfigRecord();
  const status = await getMaintenanceStatus();
  res.json({
    config,
    status,
  });
}

/**
 * Developer-only: Update maintenance mode config / toggle ON or OFF
 */
export async function updateMaintenanceConfigHandler(req: Request, res: Response) {
  const { enabled, title, message, durationMinutes, contactInfo } = req.body;

  let userName: string | undefined;
  if (req.user?.userId) {
    const u = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { name: true },
    });
    userName = u?.name;
  }

  const result = await updateMaintenanceConfig(
    {
      enabled,
      title,
      message,
      durationMinutes: durationMinutes !== undefined ? Number(durationMinutes) : undefined,
      contactInfo,
    },
    { id: req.user?.userId, name: userName }
  );

  res.json(result);
}

/**
 * Developer-only: Extend active maintenance duration by extra minutes (+5m, +10m, etc.)
 */
export async function extendMaintenanceHandler(req: Request, res: Response) {
  const minutes = Number(req.body.minutes || 10);
  if (isNaN(minutes) || minutes <= 0) {
    throw new HttpError(400, 'Invalid minutes value');
  }

  let userName: string | undefined;
  if (req.user?.userId) {
    const u = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { name: true },
    });
    userName = u?.name;
  }

  const result = await extendMaintenanceDuration(minutes, {
    id: req.user?.userId,
    name: userName,
  });

  res.json(result);
}

/**
 * Developer-only: Immediately terminate maintenance mode
 */
export async function endMaintenanceHandler(req: Request, res: Response) {
  let userName: string | undefined;
  if (req.user?.userId) {
    const u = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { name: true },
    });
    userName = u?.name;
  }

  const result = await endMaintenanceMode({
    id: req.user?.userId,
    name: userName,
  });

  res.json(result);
}
