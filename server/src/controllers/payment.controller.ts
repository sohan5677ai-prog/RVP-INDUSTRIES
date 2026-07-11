import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { createPaymentSchema } from '../schemas/payment.schema.js';
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
    prisma.party.findMany({ where: { type: { not: 'BUYER' } }, select: { name: true } }),
    prisma.broker.findMany({ select: { name: true } }),
  ]);
  const candidates = [
    ...new Set([...parties.map((p) => p.name), ...brokers.map((b) => b.name)].filter(Boolean)),
  ];
  const data = await extractTransactionData(req.file.buffer, req.file.mimetype, 'payment', candidates);
  console.log('[extract:payment]', JSON.stringify(data));
  res.json(data);
}

export async function listPayments(req: Request, res: Response) {
  const payments = await prisma.payment.findMany({
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
