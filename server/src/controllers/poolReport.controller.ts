import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { LedgerService } from '../services/ledger.service.js';
import {
  createGunnyBagSchema,
  createElectricityBillSchema,
  createMaintenanceExpenseSchema,
  createDrawingSchema,
  createInterestChargeSchema,
} from '../schemas/poolReport.schema.js';

/**
 * Delete the ledger posting (and, via cascade, the linked Payment/Receipt) that a
 * detail-page entry created. The journal `reference` is the entry's deterministic
 * key, e.g. `GUNNYBAG-<id>` — see LedgerService.recordLinkedPayment.
 */
async function reverseLinkedEntry(tx: Prisma.TransactionClient, refKey: string) {
  await tx.journalEntry.deleteMany({ where: { reference: refKey } });
}

// ── Gunny bags ────────────────────────────────────────────────────────────────
export async function listGunnyBags(_req: Request, res: Response) {
  res.json(await prisma.gunnyBagEntry.findMany({ orderBy: { date: 'desc' } }));
}

export async function createGunnyBag(req: Request, res: Response) {
  const data = createGunnyBagSchema.parse(req.body);
  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.gunnyBagEntry.create({
      data: {
        date: data.date,
        direction: data.direction,
        quantity: data.quantity,
        amount: data.amount,
        note: data.note ?? null,
      },
    });
    const refKey = `GUNNYBAG-${row.id}`;
    const desc = `${data.quantity} bags${data.note ? ` — ${data.note}` : ''}`;
    // Purchase → a Payment (expense); Sale → a Receipt (income). Both show on the
    // Payments/Receipts pages and in the main P&L; the Husk Pool report keeps
    // reading the gunnyBagEntry table directly, so it is unaffected.
    if (data.direction === 'PURCHASE') {
      await LedgerService.recordLinkedPayment(tx, { date: data.date, amount: Number(data.amount), type: 'GUNNY_BAGS', description: desc, refKey });
    } else {
      await LedgerService.recordLinkedReceipt(tx, { date: data.date, amount: Number(data.amount), type: 'GUNNY_BAGS_SALE', description: desc, refKey });
    }
    return row;
  });
  res.status(201).json(created);
}

export async function deleteGunnyBag(req: Request, res: Response) {
  const row = await prisma.gunnyBagEntry.findUnique({ where: { id: req.params.id } });
  if (!row) throw new HttpError(404, 'Gunny bag entry not found');
  await prisma.$transaction(async (tx) => {
    await reverseLinkedEntry(tx, `GUNNYBAG-${row.id}`);
    await tx.gunnyBagEntry.delete({ where: { id: row.id } });
  });
  res.json({ message: 'Gunny bag entry deleted' });
}

// ── Electricity bills ───────────────────────────────────────────────────────
export async function listElectricityBills(_req: Request, res: Response) {
  res.json(await prisma.electricityBill.findMany({ orderBy: { date: 'desc' } }));
}

export async function createElectricityBill(req: Request, res: Response) {
  const data = createElectricityBillSchema.parse(req.body);
  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.electricityBill.create({
      data: {
        date: data.date,
        month: data.month,
        units: data.units,
        amount: data.amount,
        note: data.note ?? null,
      },
    });
    await LedgerService.recordLinkedPayment(tx, {
      date: data.date,
      amount: Number(data.amount),
      type: 'ELECTRICITY',
      payee: `${data.month} bill`,
      description: `${data.units} units${data.note ? ` — ${data.note}` : ''}`,
      refKey: `ELECTRICITY-${row.id}`,
    });
    return row;
  });
  res.status(201).json(created);
}

export async function deleteElectricityBill(req: Request, res: Response) {
  const row = await prisma.electricityBill.findUnique({ where: { id: req.params.id } });
  if (!row) throw new HttpError(404, 'Electricity bill not found');
  await prisma.$transaction(async (tx) => {
    await reverseLinkedEntry(tx, `ELECTRICITY-${row.id}`);
    await tx.electricityBill.delete({ where: { id: row.id } });
  });
  res.json({ message: 'Electricity bill deleted' });
}

// ── Maintenance expenses ────────────────────────────────────────────────────
export async function listMaintenanceExpenses(_req: Request, res: Response) {
  res.json(await prisma.maintenanceExpense.findMany({ orderBy: { date: 'desc' } }));
}

export async function createMaintenanceExpense(req: Request, res: Response) {
  const data = createMaintenanceExpenseSchema.parse(req.body);
  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.maintenanceExpense.create({
      data: {
        date: data.date,
        description: data.description,
        amount: data.amount,
        note: data.note ?? null,
      },
    });
    await LedgerService.recordLinkedPayment(tx, {
      date: data.date,
      amount: Number(data.amount),
      type: 'MAINTENANCE',
      payee: data.description,
      description: data.note ?? undefined,
      refKey: `MAINTENANCE-${row.id}`,
    });
    return row;
  });
  res.status(201).json(created);
}

export async function deleteMaintenanceExpense(req: Request, res: Response) {
  const row = await prisma.maintenanceExpense.findUnique({ where: { id: req.params.id } });
  if (!row) throw new HttpError(404, 'Maintenance expense not found');
  await prisma.$transaction(async (tx) => {
    await reverseLinkedEntry(tx, `MAINTENANCE-${row.id}`);
    await tx.maintenanceExpense.delete({ where: { id: row.id } });
  });
  res.json({ message: 'Maintenance expense deleted' });
}

// ── Drawings (Shabri / Reddy) ────────────────────────────────────────────────
export async function listDrawings(req: Request, res: Response) {
  const owner = req.query.owner;
  const where =
    owner === 'SHABRI' || owner === 'REDDY'
      ? { owner: owner as 'SHABRI' | 'REDDY' }
      : undefined;
  res.json(await prisma.drawing.findMany({ where, orderBy: { date: 'desc' } }));
}

export async function createDrawing(req: Request, res: Response) {
  const data = createDrawingSchema.parse(req.body);
  const ownerName = data.owner === 'SHABRI' ? 'Shabri' : 'Reddy';
  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.drawing.create({
      data: {
        date: data.date,
        owner: data.owner,
        amount: data.amount,
        note: data.note ?? null,
      },
    });
    await LedgerService.recordLinkedPayment(tx, {
      date: data.date,
      amount: Number(data.amount),
      type: 'DRAWINGS',
      payee: ownerName,
      description: data.note ?? undefined,
      refKey: `DRAWING-${row.id}`,
    });
    return row;
  });
  res.status(201).json(created);
}

export async function deleteDrawing(req: Request, res: Response) {
  const row = await prisma.drawing.findUnique({ where: { id: req.params.id } });
  if (!row) throw new HttpError(404, 'Drawing not found');
  await prisma.$transaction(async (tx) => {
    await reverseLinkedEntry(tx, `DRAWING-${row.id}`);
    await tx.drawing.delete({ where: { id: row.id } });
  });
  res.json({ message: 'Drawing deleted' });
}

// ── Interest charges (CC / Term Loan) ────────────────────────────────────────
export async function listInterestCharges(req: Request, res: Response) {
  const type = req.query.type;
  const where =
    type === 'CC' || type === 'TERM_LOAN' ? { type: type as 'CC' | 'TERM_LOAN' } : undefined;
  res.json(await prisma.interestCharge.findMany({ where, orderBy: { date: 'desc' } }));
}

export async function createInterestCharge(req: Request, res: Response) {
  const data = createInterestChargeSchema.parse(req.body);
  const isCC = data.type === 'CC';
  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.interestCharge.create({
      data: {
        date: data.date,
        type: data.type,
        amount: data.amount,
        note: data.note ?? null,
      },
    });
    await LedgerService.recordLinkedPayment(tx, {
      date: data.date,
      amount: Number(data.amount),
      type: isCC ? 'CC_INTEREST' : 'TERM_LOAN_INTEREST',
      payee: isCC ? 'Cash Credit' : 'Term Loan',
      description: data.note ?? undefined,
      refKey: `INTEREST-${row.id}`,
    });
    return row;
  });
  res.status(201).json(created);
}

export async function deleteInterestCharge(req: Request, res: Response) {
  const row = await prisma.interestCharge.findUnique({ where: { id: req.params.id } });
  if (!row) throw new HttpError(404, 'Interest charge not found');
  await prisma.$transaction(async (tx) => {
    await reverseLinkedEntry(tx, `INTEREST-${row.id}`);
    await tx.interestCharge.delete({ where: { id: row.id } });
  });
  res.json({ message: 'Interest charge deleted' });
}
