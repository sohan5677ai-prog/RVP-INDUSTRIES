import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { daysBetween, loanInterest } from '../lib/calc.js';
import { LedgerService } from '../services/ledger.service.js';
import { getCompanyProfileRow } from './settings.controller.js';
import {
  createLoanSchema,
  createRepaymentSchema,
  updateLoanSettingsSchema,
} from '../schemas/loan.schema.js';

/** Outstanding principal of a loan = principal − Σ repayments. */
function outstandingOf(loan: { principal: Prisma.Decimal; repayments: { amount: Prisma.Decimal }[] }): number {
  const repaid = loan.repayments.reduce((s, r) => s + Number(r.amount), 0);
  return Math.round((Number(loan.principal) - repaid) * 100) / 100;
}

/** The current global annual loan interest rate (%). */
export async function getCurrentLoanRate(): Promise<number> {
  const profile = await getCompanyProfileRow();
  return Number(profile.loanInterestRatePct);
}

/**
 * Earliest drawdown date among loans still OPEN (outstanding > 0). Drives the
 * days-held used to capitalise interest onto stock at transfer. Null when no
 * loan is open, in which case transfers capitalise zero interest.
 */
export async function getEarliestOpenLoanDate(): Promise<Date | null> {
  const open = await prisma.bankLoan.findFirst({
    where: { status: 'OPEN' },
    orderBy: { drawdownDate: 'asc' },
  });
  return open ? open.drawdownDate : null;
}

/**
 * List all loans with computed repaid/outstanding/accrued-interest, plus a
 * portfolio summary (the current rate, total outstanding, accrued interest to
 * date, and the interest already capitalised into stock via transfers).
 */
export async function listLoans(_req: Request, res: Response) {
  const [loans, profile, capitalisedAgg] = await Promise.all([
    prisma.bankLoan.findMany({
      orderBy: { drawdownDate: 'asc' },
      include: { repayments: { orderBy: { date: 'asc' } } },
    }),
    getCompanyProfileRow(),
    prisma.stockTransfer.aggregate({ _sum: { interestCharge: true } }),
  ]);

  const rate = Number(profile.loanInterestRatePct);
  const now = new Date();

  const rows = loans.map((loan) => {
    const repaidAmount = loan.repayments.reduce((s, r) => s + Number(r.amount), 0);
    const outstanding = outstandingOf(loan);
    // Accrued interest to date on the outstanding balance, at the loan's rate.
    const accruedInterestToDate =
      loan.status === 'OPEN'
        ? loanInterest(outstanding, Number(loan.interestRatePct), daysBetween(loan.drawdownDate, now))
        : 0;
    return {
      ...loan,
      repaidAmount: Math.round(repaidAmount * 100) / 100,
      outstanding,
      accruedInterestToDate,
    };
  });

  const totalOutstanding = rows.reduce((s, r) => s + r.outstanding, 0);
  const totalAccruedInterest = rows.reduce((s, r) => s + r.accruedInterestToDate, 0);
  const earliestOpenLoanDate = await getEarliestOpenLoanDate();

  res.json({
    loans: rows,
    summary: {
      rate,
      totalOutstanding: Math.round(totalOutstanding * 100) / 100,
      totalAccruedInterest: Math.round(totalAccruedInterest * 100) / 100,
      interestCapitalised: Number(capitalisedAgg._sum.interestCharge ?? 0),
      earliestOpenLoanDate,
    },
  });
}

/** Record a new loan drawdown and post the principal to the GL. */
export async function createLoan(req: Request, res: Response) {
  const data = createLoanSchema.parse(req.body);
  const rate = data.interestRatePct ?? (await getCurrentLoanRate());

  const loan = await prisma.$transaction(async (tx) => {
    const created = await tx.bankLoan.create({
      data: {
        principal: data.principal,
        name: data.name ?? null,
        personName: data.personName ?? null,
        drawdownDate: data.drawdownDate,
        loanRef: data.loanRef ?? null,
        bankName: data.bankName ?? null,
        location: data.location ?? null,
        interestRatePct: rate,
        notes: data.notes ?? null,
      },
    });
    await LedgerService.postLoanDrawdown(tx, created.id, {
      date: data.drawdownDate,
      amount: data.principal,
      bankName: data.bankName,
      loanRef: data.loanRef,
    });
    return created;
  });

  res.status(201).json(loan);
}

/** Delete a loan (only when it has no repayments). Reverses the drawdown GL. */
export async function deleteLoan(req: Request, res: Response) {
  const loan = await prisma.bankLoan.findUnique({
    where: { id: req.params.id },
    include: { repayments: true },
  });
  if (!loan) throw new HttpError(404, 'Loan not found');
  if (loan.repayments.length > 0) {
    throw new HttpError(400, 'Delete the loan repayments before deleting the loan');
  }

  await prisma.$transaction(async (tx) => {
    await tx.journalEntry.deleteMany({ where: { reference: `LOAN-DRAW-${loan.id}` } });
    await tx.bankLoan.delete({ where: { id: loan.id } });
  });

  res.json({ message: 'Loan deleted' });
}

/** Record a repayment against a loan; auto-close it once fully repaid. */
export async function createRepayment(req: Request, res: Response) {
  const data = createRepaymentSchema.parse(req.body);
  const loan = await prisma.bankLoan.findUnique({
    where: { id: req.params.id },
    include: { repayments: true },
  });
  if (!loan) throw new HttpError(404, 'Loan not found');

  const outstanding = outstandingOf(loan);
  if (data.amount > outstanding + 0.01) {
    throw new HttpError(400, `Repayment ₹${data.amount} exceeds the outstanding ₹${outstanding}`);
  }

  const repayment = await prisma.$transaction(async (tx) => {
    const created = await tx.loanRepayment.create({
      data: {
        loanId: loan.id,
        amount: data.amount,
        date: data.date,
        reference: data.reference ?? null,
      },
    });
    await LedgerService.postLoanRepayment(tx, created.id, {
      date: data.date,
      amount: data.amount,
      reference: data.reference,
    });
    // Close the loan when the outstanding balance is cleared.
    if (outstanding - data.amount <= 0.01) {
      await tx.bankLoan.update({
        where: { id: loan.id },
        data: { status: 'CLOSED', closedDate: data.date },
      });
    }
    return created;
  });

  res.status(201).json(repayment);
}

/** Reverse a repayment: reopen the loan and drop the repayment GL. */
export async function deleteRepayment(req: Request, res: Response) {
  const repayment = await prisma.loanRepayment.findUnique({ where: { id: req.params.id } });
  if (!repayment) throw new HttpError(404, 'Repayment not found');

  await prisma.$transaction(async (tx) => {
    await tx.journalEntry.deleteMany({ where: { reference: `LOAN-REPAY-${repayment.id}` } });
    await tx.loanRepayment.delete({ where: { id: repayment.id } });
    // Removing a repayment leaves an outstanding balance → loan is OPEN again.
    await tx.bankLoan.update({
      where: { id: repayment.loanId },
      data: { status: 'OPEN', closedDate: null },
    });
  });

  res.json({ message: 'Repayment reversed' });
}

/** Read the global loan settings (the editable annual interest rate). */
export async function getLoanSettings(_req: Request, res: Response) {
  const profile = await getCompanyProfileRow();
  res.json({ loanInterestRatePct: Number(profile.loanInterestRatePct) });
}

/** Update the global annual loan interest rate. */
export async function updateLoanSettings(req: Request, res: Response) {
  const { loanInterestRatePct } = updateLoanSettingsSchema.parse(req.body);
  await getCompanyProfileRow(); // ensure the row exists
  const saved = await prisma.companyProfile.update({
    where: { id: 'default' },
    data: { loanInterestRatePct },
  });
  res.json({ loanInterestRatePct: Number(saved.loanInterestRatePct) });
}
