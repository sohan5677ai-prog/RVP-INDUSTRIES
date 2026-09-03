import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import type { WaLanguage } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { daysBetween, loanInterest } from '../lib/calc.js';
import { LedgerService } from '../services/ledger.service.js';
import { whatsappService } from '../services/whatsapp.service.js';
import {
  createPrivateLoanSchema,
  updatePrivateLoanSchema,
  createPrivateLoanRepaymentSchema,
} from '../schemas/privateLoan.schema.js';

/** Outstanding principal of a loan = principal − Σ repayments. */
export function outstandingOf(loan: { principal: Prisma.Decimal; repayments: { amount: Prisma.Decimal }[] }): number {
  const repaid = loan.repayments.reduce((s, r) => s + Number(r.amount), 0);
  return Math.round((Number(loan.principal) - repaid) * 100) / 100;
}

/**
 * "% p.a." / "% p.m." (and translated equivalents), matching whichever
 * period the loan's rate is displayed in. Baked into a single WhatsApp
 * variable (see sendPrivateLoanStatement below) rather than a second
 * approved template per period - same idea as LORRY_WORDS in
 * whatsapp.controller.ts translating a word inside one variable slot.
 */
const RATE_PERIOD_LABELS: Record<WaLanguage, { ANNUAL: string; MONTHLY: string }> = {
  EN: { ANNUAL: 'p.a.', MONTHLY: 'p.m.' },
  TE: { ANNUAL: 'వార్షికం', MONTHLY: 'నెలవారీ' },
  TA: { ANNUAL: 'ஆண்டுக்கு', MONTHLY: 'மாதத்திற்கு' },
  KN: { ANNUAL: 'ವಾರ್ಷಿಕ', MONTHLY: 'ಮಾಸಿಕ' },
  HI: { ANNUAL: 'वार्षिक', MONTHLY: 'मासिक' },
};

/** Rate formatted in the loan's own display period, e.g. "12% p.a." or "1% p.m.". */
function formatRateLabel(annualRatePct: number, period: 'ANNUAL' | 'MONTHLY', language: WaLanguage): string {
  const displayRate = period === 'MONTHLY' ? Math.round((annualRatePct / 12) * 1000) / 1000 : annualRatePct;
  return `${displayRate}% ${RATE_PERIOD_LABELS[language][period]}`;
}

/**
 * List all private loans with computed repaid/outstanding/accrued-interest,
 * plus a portfolio summary.
 */
export async function listPrivateLoans(_req: Request, res: Response) {
  const loans = await prisma.privateLoan.findMany({
    orderBy: { startDate: 'asc' },
    include: {
      repayments: { orderBy: { date: 'asc' } },
      reminderSchedule: true,
    },
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
        interestPeriod: data.interestPeriod ?? 'ANNUAL',
        notes: data.notes ?? null,
        waLanguage: data.waLanguage ?? 'EN',
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

/** Update an existing private loan and adjust the disbursement GL. */
export async function updatePrivateLoan(req: Request, res: Response) {
  const data = updatePrivateLoanSchema.parse(req.body);
  const loan = await prisma.privateLoan.findUnique({
    where: { id: req.params.id },
    include: { repayments: true },
  });
  if (!loan) throw new HttpError(404, 'Loan not found');

  const repaidAmount = loan.repayments.reduce((s, r) => s + Number(r.amount), 0);
  if (data.principal < repaidAmount - 0.01) {
    throw new HttpError(400, `Principal cannot be less than already repaid amount (₹${repaidAmount.toLocaleString('en-IN')})`);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const newOutstanding = Math.round((data.principal - repaidAmount) * 100) / 100;
    const newStatus = newOutstanding <= 0.01 ? 'CLOSED' : 'OPEN';

    const upd = await tx.privateLoan.update({
      where: { id: loan.id },
      data: {
        borrowerName: data.borrowerName,
        phone: data.phone ?? null,
        phone2: data.phone2 ?? null,
        principal: data.principal,
        startDate: data.startDate,
        interestRatePct: data.interestRatePct,
        interestPeriod: data.interestPeriod ?? 'ANNUAL',
        notes: data.notes ?? null,
        waLanguage: data.waLanguage ?? 'EN',
        status: newStatus,
        closedDate: newStatus === 'CLOSED' ? (loan.closedDate ?? new Date()) : null,
      },
    });

    // Re-post disbursement journal entry
    await tx.journalEntry.deleteMany({ where: { reference: `PRIVATE-LOAN-DRAW-${loan.id}` } });
    await LedgerService.postPrivateLoanDisbursement(tx, loan.id, {
      date: data.startDate,
      amount: data.principal,
      borrowerName: data.borrowerName,
    });

    return upd;
  });

  res.json(updated);
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

/**
 * Core send helper for a private loan's WhatsApp statement. Shared by the manual
 * button (sendPrivateLoanStatement) and the automated scheduler sweep
 * (runPrivateLoanReminderSchedulesSweep in whatsappJobs.ts).
 */
export async function sendPrivateLoanStatementCore(loanId: string) {
  const loan = await prisma.privateLoan.findUnique({
    where: { id: loanId },
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

  const rateLabel = formatRateLabel(Number(loan.interestRatePct), loan.interestPeriod, loan.waLanguage);

  const result = await whatsappService.sendPrivateLoanStatement({
    borrowerName: loan.borrowerName,
    phones: [loan.phone, loan.phone2],
    outstanding,
    rateLabel,
    accruedInterest: accruedInterestToDate,
    loanId: loan.id,
    language: loan.waLanguage,
  });
  if (!result.ok) throw new HttpError(502, result.error ?? 'WhatsApp send failed');
  return { ok: true, outstanding, accruedInterestToDate };
}

/** Send the borrower a WhatsApp statement of their outstanding loan + accrued interest. */
export async function sendPrivateLoanStatement(req: Request, res: Response) {
  const result = await sendPrivateLoanStatementCore(req.params.id);
  res.json(result);
}

// --- Private Loan reminder schedule ("Schedule" option) ---------------------

const REMINDER_FREQUENCIES = ['DAILY', 'WEEKLY', 'INTERVAL'] as const;
const REMINDER_STOP_CONDITIONS = ['UNTIL_PAID', 'UNTIL_DATE', 'AFTER_COUNT', 'MANUAL'] as const;

/** GET - the loan's current reminder schedule, or `null` if none set up. */
export async function getPrivateLoanReminderSchedule(req: Request, res: Response) {
  const schedule = await prisma.privateLoanReminderSchedule.findUnique({
    where: { loanId: req.params.id },
  });
  res.json(schedule);
}

/**
 * PUT - create or replace the loan's reminder schedule.
 */
export async function upsertPrivateLoanReminderSchedule(req: Request, res: Response) {
  const loan = await prisma.privateLoan.findUnique({
    where: { id: req.params.id },
    select: { id: true, borrowerName: true },
  });
  if (!loan) throw new HttpError(404, 'Loan not found');

  const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {}) as {
    enabled?: unknown;
    hour?: unknown;
    minute?: unknown;
    frequency?: unknown;
    daysOfWeek?: unknown;
    intervalDays?: unknown;
    stopCondition?: unknown;
    endDate?: unknown;
    maxSends?: unknown;
  };

  const enabled = body.enabled !== false;
  const hour = body.hour;
  const minute = body.minute;
  if (!Number.isInteger(hour) || (hour as number) < 0 || (hour as number) > 23) {
    throw new HttpError(400, 'hour must be an integer 0-23');
  }
  if (!Number.isInteger(minute) || (minute as number) < 0 || (minute as number) > 59) {
    throw new HttpError(400, 'minute must be an integer 0-59');
  }

  const frequency = body.frequency;
  if (typeof frequency !== 'string' || !REMINDER_FREQUENCIES.includes(frequency as typeof REMINDER_FREQUENCIES[number])) {
    throw new HttpError(400, `frequency must be one of ${REMINDER_FREQUENCIES.join(', ')}`);
  }

  let daysOfWeek: number[] = [];
  if (frequency === 'WEEKLY') {
    if (!Array.isArray(body.daysOfWeek) || !body.daysOfWeek.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) || body.daysOfWeek.length === 0) {
      throw new HttpError(400, 'daysOfWeek must be a non-empty array of integers 0-6 when frequency is WEEKLY');
    }
    daysOfWeek = [...new Set(body.daysOfWeek as number[])].sort((a, b) => a - b);
  }

  let intervalDays: number | null = null;
  if (frequency === 'INTERVAL') {
    if (!Number.isInteger(body.intervalDays) || (body.intervalDays as number) < 1 || (body.intervalDays as number) > 365) {
      throw new HttpError(400, 'intervalDays must be an integer 1-365 when frequency is INTERVAL');
    }
    intervalDays = body.intervalDays as number;
  }

  const stopCondition = body.stopCondition;
  if (typeof stopCondition !== 'string' || !REMINDER_STOP_CONDITIONS.includes(stopCondition as typeof REMINDER_STOP_CONDITIONS[number])) {
    throw new HttpError(400, `stopCondition must be one of ${REMINDER_STOP_CONDITIONS.join(', ')}`);
  }

  let endDate: Date | null = null;
  if (stopCondition === 'UNTIL_DATE') {
    const parsed = typeof body.endDate === 'string' ? new Date(body.endDate) : null;
    if (!parsed || Number.isNaN(parsed.getTime())) {
      throw new HttpError(400, 'endDate must be a valid date when stopCondition is UNTIL_DATE');
    }
    endDate = parsed;
  }

  let maxSends: number | null = null;
  if (stopCondition === 'AFTER_COUNT') {
    if (!Number.isInteger(body.maxSends) || (body.maxSends as number) < 1) {
      throw new HttpError(400, 'maxSends must be a positive integer when stopCondition is AFTER_COUNT');
    }
    maxSends = body.maxSends as number;
  }

  const schedule = await prisma.privateLoanReminderSchedule.upsert({
    where: { loanId: loan.id },
    create: {
      loanId: loan.id,
      enabled,
      hour: hour as number,
      minute: minute as number,
      frequency,
      daysOfWeek,
      intervalDays,
      stopCondition,
      endDate,
      maxSends,
    },
    update: {
      enabled,
      hour: hour as number,
      minute: minute as number,
      frequency,
      daysOfWeek,
      intervalDays,
      stopCondition,
      endDate,
      maxSends,
      stoppedReason: null,
      sendsCount: 0,
      lastSentKey: null,
    },
  });
  res.json(schedule);
}

/** DELETE - remove the loan's reminder schedule entirely. */
export async function deletePrivateLoanReminderSchedule(req: Request, res: Response) {
  await prisma.privateLoanReminderSchedule.deleteMany({ where: { loanId: req.params.id } });
  res.json({ ok: true });
}

