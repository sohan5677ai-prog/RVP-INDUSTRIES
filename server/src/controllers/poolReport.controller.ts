import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { LedgerService } from '../services/ledger.service.js';
import {
  createGunnyBagSchema,
  createElectricityBillSchema,
  createMaintenanceExpenseSchema,
  createMiscExpenseSchema,
  createDrawingSchema,
  createInterestChargeSchema,
  createTermLoanPrincipalSchema,
  createStorageMaintenanceSchema,
  createOtherIncomeSchema,
  createGunnySaleSchema,
} from '../schemas/poolReport.schema.js';

/**
 * Delete the ledger posting (and, via cascade, the linked Payment/Receipt) that a
 * detail-page entry created. The journal `reference` is the entry's deterministic
 * key, e.g. `GUNNYBAG-<id>` - see LedgerService.recordLinkedPayment.
 */
async function reverseLinkedEntry(tx: Prisma.TransactionClient, refKey: string) {
  await tx.journalEntry.deleteMany({ where: { reference: refKey } });
}

// ── Gunny bags ────────────────────────────────────────────────────────────────
export async function listGunnyBags(_req: Request, res: Response) {
  const rows = await prisma.gunnyBagEntry.findMany({ orderBy: { date: 'asc' } });
  // Backfill in-memory for old rows (direction is set but debit/credit are 0)
  const backfilled = rows.map((r) => {
    const debitVal = Number(r.debit || 0);
    const creditVal = Number(r.credit || 0);
    const amountVal = Number(r.amount || 0);
    if (debitVal === 0 && creditVal === 0 && r.direction) {
      return {
        ...r,
        debit: r.direction === 'PURCHASE' ? amountVal : 0,
        credit: r.direction === 'SALE' ? amountVal : 0,
        payment: r.type === 'PAYMENT' ? amountVal : 0,
      };
    }
    return r;
  });
  res.json(backfilled);
}

export async function createGunnyBag(req: Request, res: Response) {
  const data = createGunnyBagSchema.parse(req.body);
  const created = await prisma.$transaction(async (tx) => {
    // Populate debit/credit/payment based on type
    let debit = 0, credit = 0, payment = 0;
    if (data.type === 'PURCHASE') {
      debit = Number(data.amount);
      // Purchase is on credit into Feroz Ledger (no auto-paid)
    } else if (data.type === 'SALE') {
      credit = Number(data.amount);
    } else if (data.type === 'PAYMENT') {
      payment = Number(data.amount);
    }

    const row = await tx.gunnyBagEntry.create({
      data: {
        date: data.date,
        type: data.type,
        quantity: data.quantity ?? null,
        debit,
        credit,
        payment,
        note: data.note ?? null,
        // Backfill legacy fields for old data that might still reference them
        direction: data.type === 'PURCHASE' ? 'PURCHASE' : data.type === 'SALE' ? 'SALE' : null,
        amount: data.amount,
      },
    });
    const refKey = `GUNNYBAG-${row.id}`;
    const bagDesc = data.quantity ? `${data.quantity} bags` : 'Payment';
    const desc = `${bagDesc}${data.note ? ` - ${data.note}` : ''}`;

    // Purchase is on credit (no auto payment).
    // Sale -> linked Receipt (gunny bag sales income)
    // Payment -> linked Payment (cash/bank paid to Feroz)
    if (data.type === 'SALE') {
      await LedgerService.recordLinkedReceipt(tx, { date: data.date, amount: Number(data.amount), type: 'GUNNY_BAGS_SALE', description: desc, refKey });
    } else if (data.type === 'PAYMENT') {
      await LedgerService.recordLinkedPayment(tx, { date: data.date, amount: Number(data.amount), type: 'GUNNY_BAGS', description: desc, refKey });
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
      description: `${data.units} units${data.note ? ` - ${data.note}` : ''}`,
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

// ── Miscellaneous expenses ──────────────────────────────────────────────────
export async function listMiscExpenses(_req: Request, res: Response) {
  res.json(await prisma.miscExpense.findMany({ orderBy: { date: 'desc' } }));
}

export async function createMiscExpense(req: Request, res: Response) {
  const data = createMiscExpenseSchema.parse(req.body);
  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.miscExpense.create({
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
      type: 'MISC_EXPENSE',
      payee: data.description,
      description: data.note ?? undefined,
      refKey: `MISCEXP-${row.id}`,
    });
    return row;
  });
  res.status(201).json(created);
}

export async function deleteMiscExpense(req: Request, res: Response) {
  const row = await prisma.miscExpense.findUnique({ where: { id: req.params.id } });
  if (!row) throw new HttpError(404, 'Miscellaneous expense not found');
  await prisma.$transaction(async (tx) => {
    await reverseLinkedEntry(tx, `MISCEXP-${row.id}`);
    await tx.miscExpense.delete({ where: { id: row.id } });
  });
  res.json({ message: 'Miscellaneous expense deleted' });
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

// ── Term-loan principal (informational list, no GL posting) ──────────────────
export async function listTermLoanPrincipals(_req: Request, res: Response) {
  res.json(await prisma.termLoanPrincipal.findMany({ orderBy: { date: 'desc' } }));
}

export async function createTermLoanPrincipal(req: Request, res: Response) {
  const data = createTermLoanPrincipalSchema.parse(req.body);
  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.termLoanPrincipal.create({
      data: { date: data.date, amount: data.amount, note: data.note ?? null },
    });
    await LedgerService.recordLinkedPayment(tx, {
      date: data.date,
      amount: Number(data.amount),
      type: 'TERM_LOAN_PRINCIPAL',
      payee: 'Term Loan Principal',
      description: data.note ?? undefined,
      refKey: `PRINCIPAL-${row.id}`,
    });
    return row;
  });
  res.status(201).json(created);
}

export async function deleteTermLoanPrincipal(req: Request, res: Response) {
  const row = await prisma.termLoanPrincipal.findUnique({ where: { id: req.params.id } });
  if (!row) throw new HttpError(404, 'Term loan principal entry not found');
  await prisma.$transaction(async (tx) => {
    await reverseLinkedEntry(tx, `PRINCIPAL-${row.id}`);
    await tx.termLoanPrincipal.delete({ where: { id: row.id } });
  });
  res.json({ message: 'Term loan principal entry deleted' });
}

// ── Storage maintenance (godown electricity / staff salaries) ─────────────────
export async function listStorageMaintenance(req: Request, res: Response) {
  const kind = req.query.kind;
  const where =
    kind === 'ELECTRICITY' || kind === 'SALARY'
      ? { kind: kind as 'ELECTRICITY' | 'SALARY' }
      : undefined;
  res.json(await prisma.storageMaintenanceExpense.findMany({ where, orderBy: { date: 'desc' } }));
}

export async function createStorageMaintenance(req: Request, res: Response) {
  const data = createStorageMaintenanceSchema.parse(req.body);
  const isElectricity = data.kind === 'ELECTRICITY';
  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.storageMaintenanceExpense.create({
      data: {
        date: data.date,
        kind: data.kind,
        label: data.label ?? null,
        amount: data.amount,
        note: data.note ?? null,
      },
    });
    await LedgerService.recordLinkedPayment(tx, {
      date: data.date,
      amount: Number(data.amount),
      type: isElectricity ? 'STORAGE_ELECTRICITY' : 'STORAGE_SALARY',
      payee: data.label ?? (isElectricity ? 'Storage Electricity' : 'Storage Salary'),
      description: data.note ?? undefined,
      refKey: `STORAGEEXP-${row.id}`,
    });
    return row;
  });
  res.status(201).json(created);
}

export async function deleteStorageMaintenance(req: Request, res: Response) {
  const row = await prisma.storageMaintenanceExpense.findUnique({ where: { id: req.params.id } });
  if (!row) throw new HttpError(404, 'Storage maintenance entry not found');
  await prisma.$transaction(async (tx) => {
    await reverseLinkedEntry(tx, `STORAGEEXP-${row.id}`);
    await tx.storageMaintenanceExpense.delete({ where: { id: row.id } });
  });
  res.json({ message: 'Storage maintenance entry deleted' });
}

// ── Other income (husk-pool Income tab catch-all) ──────────────────────────────
export async function listOtherIncome(_req: Request, res: Response) {
  res.json(await prisma.otherIncomeEntry.findMany({ orderBy: { date: 'desc' } }));
}

export async function createOtherIncome(req: Request, res: Response) {
  const data = createOtherIncomeSchema.parse(req.body);
  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.otherIncomeEntry.create({
      data: {
        date: data.date,
        label: data.label,
        amount: data.amount,
        note: data.note ?? null,
      },
    });
    await LedgerService.recordLinkedReceipt(tx, {
      date: data.date,
      amount: Number(data.amount),
      type: 'OTHER_INCOME',
      payer: data.label,
      description: data.note ?? undefined,
      refKey: `OTHERINCOME-${row.id}`,
    });
    return row;
  });
  res.status(201).json(created);
}

export async function deleteOtherIncome(req: Request, res: Response) {
  const row = await prisma.otherIncomeEntry.findUnique({ where: { id: req.params.id } });
  if (!row) throw new HttpError(404, 'Other income entry not found');
  await prisma.$transaction(async (tx) => {
    await reverseLinkedEntry(tx, `OTHERINCOME-${row.id}`);
    await tx.otherIncomeEntry.delete({ where: { id: row.id } });
  });
  res.json({ message: 'Other income entry deleted' });
}

// ── Standalone Gunny Sales (husk-pool Income tab) ─────────────────────────────
export async function listGunnySales(_req: Request, res: Response) {
  res.json(await prisma.gunnySaleEntry.findMany({ orderBy: { date: 'desc' } }));
}

export async function createGunnySale(req: Request, res: Response) {
  const data = createGunnySaleSchema.parse(req.body);
  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.gunnySaleEntry.create({
      data: {
        date: data.date,
        bags: data.bags,
        price: data.price,
        amount: data.amount,
        note: data.note ?? null,
      },
    });
    const desc = `${data.bags} bags @ ₹${data.price}/bag${data.note ? ` - ${data.note}` : ''}`;
    await LedgerService.recordLinkedReceipt(tx, {
      date: data.date,
      amount: Number(data.amount),
      type: 'GUNNY_BAGS_SALE',
      description: desc,
      refKey: `GUNNYSALE-${row.id}`,
    });
    return row;
  });
  res.status(201).json(created);
}

export async function deleteGunnySale(req: Request, res: Response) {
  const row = await prisma.gunnySaleEntry.findUnique({ where: { id: req.params.id } });
  if (!row) throw new HttpError(404, 'Gunny sale entry not found');
  await prisma.$transaction(async (tx) => {
    await reverseLinkedEntry(tx, `GUNNYSALE-${row.id}`);
    await tx.gunnySaleEntry.delete({ where: { id: row.id } });
  });
  res.json({ message: 'Gunny sale entry deleted' });
}

