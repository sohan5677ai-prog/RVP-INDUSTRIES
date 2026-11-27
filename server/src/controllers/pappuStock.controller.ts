import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { recordManualHamaliCost, removeManualHamaliCost } from './manualHamaliCost.controller.js';

/**
 * Stock → Pappu Stock.
 *
 * Stock IN  = Pappu Transfer hamali entries (ManualHamaliCost type PAPPU_TRANSFER):
 *             each one is a load moved mill → storage, charged ₹270/t to the crew.
 * Stock OUT = Pappu sale dispatches ticked "Dispatch from Transfers", by the
 *             storage they were lifted from (transferWeightKg, else the full lorry).
 * Balance per storage = in − out; each transfer's own balance is drawn down FIFO.
 */
export async function getPappuStock(_req: Request, res: Response) {
  const [transfers, dispatches] = await Promise.all([
    prisma.manualHamaliCost.findMany({
      where: { type: 'PAPPU_TRANSFER' },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    }),
    prisma.saleDispatch.findMany({
      where: { fromTransfer: true, saleOrder: { product: 'PAPPU' } },
      select: {
        id: true,
        dispatchDate: true,
        invoiceNumber: true,
        vehicleNumber: true,
        weightKg: true,
        transferWeightKg: true,
        transferLocation: true,
        status: true,
        saleOrder: { select: { id: true, buyer: { select: { name: true } } } },
      },
      orderBy: { dispatchDate: 'desc' },
    }),
  ]);

  const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

  const sales = dispatches.map((d) => ({
    id: d.id,
    saleOrderId: d.saleOrder.id,
    dispatchDate: d.dispatchDate,
    invoiceNumber: d.invoiceNumber,
    vehicleNumber: d.vehicleNumber,
    buyerName: d.saleOrder.buyer?.name ?? '-',
    location: d.transferLocation || 'Unassigned',
    fromStorageKg: d.transferWeightKg ?? d.weightKg,
    totalWeightKg: d.weightKg,
    status: d.status,
  }));

  // FIFO: oldest transfer into a storage is used up first by that storage's sales.
  const soldLeft = new Map<string, number>();
  for (const s of sales) soldLeft.set(norm(s.location), (soldLeft.get(norm(s.location)) ?? 0) + s.fromStorageKg);
  const oldestFirst = [...transfers].sort(
    (a, b) => a.date.getTime() - b.date.getTime() || a.createdAt.getTime() - b.createdAt.getTime(),
  );
  const used = new Map<string, number>();
  for (const t of oldestFirst) {
    const key = norm(t.toLocation || 'Unassigned');
    const avail = soldLeft.get(key) ?? 0;
    const take = Math.min(t.weightKg ?? 0, avail);
    soldLeft.set(key, avail - take);
    used.set(t.id, take);
  }

  res.json({
    transfers: transfers.map((t) => {
      const weightKg = t.weightKg ?? 0;
      const soldKg = used.get(t.id) ?? 0;
      return {
        id: t.id,
        date: t.date,
        toLocation: t.toLocation || 'Unassigned',
        lorryNumber: t.lorryNumber,
        weightKg,
        ratePerTonne: t.ratePerTonne,
        hamaliAmount: t.amount,
        note: t.note,
        soldKg,
        remainingKg: Math.max(0, weightKg - soldKg),
        createdAt: t.createdAt,
      };
    }),
    sales,
  });
}

const createPappuTransferSchema = z.object({
  date: z.coerce.date(),
  weightKg: z.coerce.number().int().positive(),
  toLocation: z.string().trim().min(1, 'Pick a storage location').max(80),
  lorryNumber: z.string().trim().max(20).optional().nullable(),
  ratePerTonne: z.coerce.number().positive().optional().nullable(),
  note: z.string().trim().max(200).optional().nullable(),
});

/** Record a mill → storage transfer; books its Pappu Transfer hamali in the same step. */
export async function createPappuTransfer(req: Request, res: Response) {
  const data = createPappuTransferSchema.parse(req.body);
  const created = await recordManualHamaliCost(
    { ...data, type: 'PAPPU_TRANSFER' },
    req.user?.userId ?? null,
  );
  res.status(201).json(created);
}

const updatePappuTransferSchema = z.object({
  toLocation: z.string().trim().min(1).max(80),
  lorryNumber: z.string().trim().max(20).optional().nullable(),
  note: z.string().trim().max(200).optional().nullable(),
});

/**
 * Fix where a transfer went / which lorry. Weight and date drive the hamali
 * posting, so those are changed by deleting and re-recording instead.
 */
export async function updatePappuTransfer(req: Request, res: Response) {
  const data = updatePappuTransferSchema.parse(req.body);
  const t = await prisma.manualHamaliCost.findUnique({ where: { id: req.params.id } });
  if (!t || t.type !== 'PAPPU_TRANSFER') throw new HttpError(404, 'Pappu transfer not found');
  const updated = await prisma.manualHamaliCost.update({
    where: { id: t.id },
    data: {
      toLocation: data.toLocation,
      lorryNumber: data.lorryNumber ? data.lorryNumber.toUpperCase() : null,
      note: data.note ?? null,
    },
  });
  res.json(updated);
}

/** Reverse a transfer: removes the stock-in and its hamali charge + journal. */
export async function deletePappuTransfer(req: Request, res: Response) {
  const t = await prisma.manualHamaliCost.findUnique({ where: { id: req.params.id } });
  if (!t || t.type !== 'PAPPU_TRANSFER') throw new HttpError(404, 'Pappu transfer not found');
  await removeManualHamaliCost(t.id);
  res.json({ message: 'Pappu transfer reversed' });
}
