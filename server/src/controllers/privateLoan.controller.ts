import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { daysBetween, loanInterest } from '../lib/calc.js';
import { LedgerService } from '../services/ledger.service.js';
import { whatsappService } from '../services/whatsapp.service.js';
import {
  createPrivateLoanSchema,
  createPrivateLoanRepaymentSchema,
} from '../schemas/privateLoan.schema.js';

/** Outstanding principal of a loan = principal − Σ repayments. */
function outstandingOf(loan: { principal: Prisma.Decimal; repayments: { amount: Prisma.Decimal }[] }): number {
  const repaid = loan.repayments.reduce((s, r) => s + Number(r.amount), 0);
  return Math.round((Number(loan.principal) - repaid) * 100) / 100;
}

/**
 * List all private loans with computed repaid/outstanding/accrued-interest,
 * plus a portfolio summary.
 */
export async function listPrivateLoans(_req: Request, res: Response) {
  const loans = await prisma.privateLoan.findMany({
    orderBy: { startDate: 'asc' },
    include: { repayments: { orderBy: { date: 'asc' } } },
  });

  const now = new Date();
  const rows = loans.map((loan) => {
    const repaidAmount = loan.repayments.reduce((s, r) => s + Number(r.amount), 0);
    const interestReceived = loan.repayments.reduce((s, r) => s + Number(r.interest), 0);
    const outstanding = outstandingOf(loan);
    // Accrued interest to date on the outstanding balance, at the loan's rate.
    const accruedInterestToDate =
      loan.status === 'OPEN'
        ? loanInterest(outstanding, Number(loan.interestRatePct), daysBetween(loan.startDate, now))
        : 0;
    return {
      ...loan,
      repaidAmount: Math.round(repaidAmount * 100) / 100,
      interestReceived: Math.round(interestReceived * 100) / 100,
      outstanding,
      accruedInterestToDate,
    };
  });

  const totalOutstanding = rows.reduce((s, r) => s + r.outstanding, 0);
  const totalAccruedInterest = rows.reduce((s, r) => s + r.accruedInterestToDate, 0);
  const totalInterestReceived = rows.reduce((s, r) => s + r.interestReceived, 0);

  res.json({
    loans: rows,
    summary: {
      totalOutstanding: Math.round(totalOutstanding * 100) / 100,
      totalAccruedInterest: Math.round(totalAccruedInterest * 100) / 100,
      totalInterestReceived: Math.round(totalInterestReceived * 100) / 100,
    },
  });
}

/** Record a new private loan and post the disbursement to the GL. */
export async function createPrivateLoan(req: Request, res: Response) {
  const data = createPrivateLoanSchema.parse(req.body);

  const loan = await prisma.$transaction(async (tx) => {
    const created = await tx.privateLoan.create({
      data: {
        borrowerName: data.borrowerName,
        phone: data.phone ?? null,
        phone2: data.phone2 ?? null,
        principal: data.principal,
        startDate: data.startDate,
        interestRatePct: data.interestRatePct,
        notes: data.notes ?? null,
      },
    });
    await LedgerService.postPrivateLoanDisbursement(tx, created.id, {
      date: data.startDate,
      amount: data.principal,
      borrowerName: data.borrowerName,
    });
    return created;
  });

  res.status(201).json(loan);
}

/** Delete a loan (only when it has no repayments). Reverses the disbursement GL. */
export async function deletePrivateLoan(req: Request, res: Response) {
  const loan = await prisma.privateLoan.findUnique({
    where: { id: req.params.id },
    include: { repayments: true },
  });
  if (!loan) throw new HttpError(404, 'Loan not found');
  if (loan.repayments.length > 0) {
    throw new HttpError(400, 'Delete the loan repayments before deleting the loan');
  }

  await prisma.$transaction(async (tx) => {
    await tx.journalEntry.deleteMany({ where: { reference: `PRIVATE-LOAN-DRAW-${loan.id}` } });
    await tx.privateLoan.delete({ where: { id: loan.id } });
  });

  res.json({ message: 'Loan deleted' });
}

/** Record a repayment against a private loan; auto-close it once fully repaid. */
export async function createPrivateLoanRepayment(req: Request, res: Response) {
  const data = createPrivateLoanRepaymentSchema.parse(req.body);
  const loan = await prisma.privateLoan.findUnique({
    where: { id: req.params.id },
    include: { repayments: true },
  });
  if (!loan) throw new HttpError(404, 'Loan not found');

  const outstanding = outstandingOf(loan);
  if (data.amount > outstanding + 0.01) {
    throw new HttpError(400, `Repayment ₹${data.amount} exceeds the outstanding ₹${outstanding}`);
  }

  const interest = data.interest ?? 0;
  const repayment = await prisma.$transaction(async (tx) => {
    const created = await tx.privateLoanRepayment.create({
      data: {
        loanId: loan.id,
        amount: data.amount,
        interest,
        date: data.date,
        reference: data.reference ?? null,
      },
    });
    await LedgerService.postPrivateLoanRepayment(tx, created.id, {
      date: data.date,
      amount: data.amount,
      interest,
      reference: data.reference,
    });
    if (outstanding - data.amount <= 0.01 || data.closeLoan) {
      await tx.privateLoan.update({
        where: { id: loan.id },
        data: { status: 'CLOSED', closedDate: data.date },
      });
    }
    return created;
  });

  res.status(201).json(repayment);
}

/** Reverse a repayment: reopen the loan and drop the repayment GL. */
export async function deletePrivateLoanRepayment(req: Request, res: Response) {
  const repayment = await prisma.privateLoanRepayment.findUnique({ where: { id: req.params.id } });
  if (!repayment) throw new HttpError(404, 'Repayment not found');

  await prisma.$transaction(async (tx) => {
    await tx.journalEntry.deleteMany({ where: { reference: `PRIVATE-LOAN-REPAY-${repayment.id}` } });
    await tx.privateLoanRepayment.delete({ where: { id: repayment.id } });
    await tx.privateLoan.update({
      where: { id: repayment.loanId },
      data: { status: 'OPEN', closedDate: null },
    });
  });

  res.json({ message: 'Repayment reversed' });
}

/** Send the borrower a WhatsApp statement of their outstanding loan + accrued interest. */
export async function sendPrivateLoanStatement(req: Request, res: Response) {
  const loan = await prisma.privateLoan.findUnique({
    where: { id: req.params.id },
    include: { repayments: true },
  });
  if (!loan) throw new HttpError(404, 'Loan not found');
  if (!loan.phone && !loan.phone2) {
    throw new HttpError(400, `${loan.borrowerName} has no phone number on file for this loan`);
  }

  const outstanding = outstandingOf(loan);
  const accruedInterestToDate =
    loan.status === 'OPEN'
      ? loanInterest(outstanding, Number(loan.interestRatePct), daysBetween(loan.startDate, new Date()))
      : 0;

  const result = await whatsappService.sendPrivateLoanStatement({
    borrowerName: loan.borrowerName,
    phones: [loan.phone, loan.phone2],
    outstanding,
    ratePct: Number(loan.interestRatePct),
    accruedInterest: accruedInterestToDate,
    loanId: loan.id,
  });
  if (!result.ok) throw new HttpError(502, result.error ?? 'WhatsApp send failed');
  res.json({ ok: true, outstanding, accruedInterestToDate });
}
