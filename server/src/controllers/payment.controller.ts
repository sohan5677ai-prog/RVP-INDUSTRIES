import { logger } from '../lib/logger.js';
import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { createPaymentSchema, listPaymentsSchema } from '../schemas/payment.schema.js';
import { LedgerService } from '../services/ledger.service.js';
import { extractTransactionData } from '../lib/gemini.js';

/**
 * Read an uploaded payment screenshot (bank/UPI/cheque) with Gemini and return
 * the fields it could extract, so the client can pre-fill the payment form. The
 * counterparty here is whoever WE PAID, so we offer suppliers + brokers as the
 * known-party candidates for matching. Nothing is persisted.
 */
export async function extractPaymentScreenshot(req: Request, res: Response) {
  if (!req.file) throw new HttpError(400, 'Screenshot file is required');
  const [parties, brokers] = await Promise.all([
    prisma.party.findMany({ where: { type: { notIn: ['BUYER', 'HAMALI_TEAM'] } }, select: { name: true } }),
    prisma.broker.findMany({ select: { name: true } }),
  ]);
  const candidates = [
    ...new Set([...parties.map((p) => p.name), ...brokers.map((b) => b.name)].filter(Boolean)),
  ];
  const data = await extractTransactionData(req.file.buffer, req.file.mimetype, 'payment', candidates);
  logger.info('[extract:payment]', JSON.stringify(data));
  res.json(data);
}

export async function listPayments(req: Request, res: Response) {
  const { skip, take, all } = listPaymentsSchema.parse(req.query);
  const isAll = all === 'true';
  const payments = await prisma.payment.findMany({
    skip: isAll ? undefined : skip,
    take: isAll ? undefined : take,
    // No take limit: the Purchase Dues page matches payments to bills via FIFO
    // across a supplier's full payment history. Capping at 100 makes fully-paid
    // purchases reappear as unpaid once their payment falls off the recent list.
    orderBy: { date: 'desc' },
    include: {
      party: true,
      broker: true,
    },
  });
  res.json(payments);
}

export async function createPayment(req: Request, res: Response) {
  const data = createPaymentSchema.parse(req.body);

  // Double-submit guard: reject an identical payment (same counterparty, amount
  // and value date) created within the last 10 seconds. A fast double-click on
  // "Record Payment" fires two requests before the button disables; this stops
  // the second from becoming a phantom duplicate. Keyed on the full identity
  // (party/broker/lorry) so genuinely distinct payments that merely share an
  // amount — e.g. two lorries with the same freight — are never blocked.
  const recentDuplicate = await prisma.payment.findFirst({
    where: {
      type: data.type,
      amount: data.amount,
      date: data.date,
      partyId: data.partyId ?? null,
      brokerId: data.brokerId ?? null,
      lorryNumber: data.lorryNumber ?? null,
      purchaseId: data.purchaseId ?? null,
      createdAt: { gte: new Date(Date.now() - 10_000) },
    },
  });
  if (recentDuplicate) {
    throw new HttpError(409, 'An identical payment was just recorded a moment ago. Refresh to confirm before recording it again.');
  }

  const payment = await prisma.$transaction(async (tx) => {
    let partyName = undefined;
    if (data.partyId) {
      const party = await tx.party.findUnique({ where: { id: data.partyId } });
      if (!party) throw new HttpError(404, 'Party not found');
      partyName = party.name;
    }

    let brokerName = undefined;
    if (data.brokerId) {
      const broker = await tx.broker.findUnique({ where: { id: data.brokerId } });
      if (!broker) throw new HttpError(404, 'Broker not found');
      brokerName = broker.name;
    }

    const created = await tx.payment.create({
      data: {
        date: data.date,
        amount: data.amount,
        type: data.type,
        partyId: data.partyId ?? null,
        purchaseId: data.purchaseId ?? null,
        brokerId: data.brokerId ?? null,
        lorryNumber: data.lorryNumber ?? null,
        payee: data.payee ?? null,
        reference: data.reference ?? null,
        description: data.description ?? null,
        hamaliVerificationId: data.hamaliVerificationId ?? null,
      },
    });

    await LedgerService.postPayment(tx, created.id, {
      date: data.date,
      amount: data.amount,
      type: data.type,
      partyName,
      brokerName,
      lorryNumber: data.lorryNumber ?? undefined,
      payee: data.payee ?? undefined,
      reference: data.reference ?? undefined,
      description: data.description ?? undefined,
    });

    const journalEntry = await tx.journalEntry.findFirst({
      where: { reference: `PAYMENT-${created.id}` },
    });

    if (journalEntry) {
      return tx.payment.update({
        where: { id: created.id },
        data: { journalEntryId: journalEntry.id },
        include: { party: true, broker: true },
      });
    }

    return created;
  });

  res.status(201).json(payment);
}

export async function deletePayment(req: Request, res: Response) {
  const payment = await prisma.payment.findUnique({ where: { id: req.params.id } });
  if (!payment) throw new HttpError(404, 'Payment not found');

  await prisma.$transaction(async (tx) => {
    if (payment.journalEntryId) {
      await tx.journalEntry.delete({ where: { id: payment.journalEntryId } });
    } else {
      await tx.payment.delete({ where: { id: payment.id } });
    }
  });

  res.json({ message: 'Payment deleted' });
}
