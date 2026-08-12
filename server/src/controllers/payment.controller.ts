import { logger } from '../lib/logger.js';
import type { Request, Response } from 'express';
import type { WaLanguage } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { createPaymentSchema, listPaymentsSchema, updatePaymentSchema } from '../schemas/payment.schema.js';
import { LedgerService } from '../services/ledger.service.js';
import { extractTransactionData } from '../lib/gemini.js';
import { uploadFileToStorage } from '../lib/upload.js';
import { whatsappService } from '../services/whatsapp.service.js';

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
  const include = { party: true, broker: true };

  // all=true → the whole history as a plain array. The Purchase Dues / Payment
  // Planner / ledger pages match payments to bills via FIFO across a supplier's
  // FULL payment history, so they must never be capped. This shape is unchanged.
  if (all === 'true') {
    const payments = await prisma.payment.findMany({ orderBy: { date: 'desc' }, include });
    res.json(payments);
    return;
  }

  // Otherwise a server-paginated page for the Payments register: return just the
  // requested slice plus the grand total, so the page renders a server-driven
  // pager instead of downloading every payment on first load.
  const [rows, total] = await Promise.all([
    prisma.payment.findMany({ skip, take, orderBy: { date: 'desc' }, include }),
    prisma.payment.count(),
  ]);
  res.json({ rows, total });
}

export async function createPayment(req: Request, res: Response) {
  const data = createPaymentSchema.parse(req.body);

  // Optional proof-of-payment screenshot: upload before the transaction starts
  // (network I/O shouldn't hold a DB transaction open).
  const screenshotUrl = req.file ? await uploadFileToStorage(req.file) : null;

  // Double-submit guard: reject an identical payment (same counterparty, amount
  // and value date) created within the last 10 seconds. A fast double-click on
  // "Record Payment" fires two requests before the button disables; this stops
  // the second from becoming a phantom duplicate. Keyed on the full identity
  // (party/broker/lorry) so genuinely distinct payments that merely share an
  // amount - e.g. two lorries with the same freight - are never blocked.
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
        screenshotUrl,
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

  // WhatsApp the counterparty (amount + screenshot) when we have a phone on
  // file, and ALWAYS copy the internal alert-recipient members - every payment
  // (supplier, broker, Hamali, expense heads, everything) gets an office copy,
  // not just party-tied ones. Fire-and-forget.
  void (async () => {
    let name: string;
    let phone: string | null = null;
    let phone2: string | null | undefined = null;
    // English unless the counterparty has a language of their own on file. A
    // payee typed free-hand (expense heads) has no record, so no language.
    let waLanguage: WaLanguage | null = null;
    if (data.partyId) {
      const party = await prisma.party.findUnique({ where: { id: data.partyId } });
      name = party?.name ?? 'Party';
      // Hamali Team is crew, not a WhatsApp-reachable party - still get the
      // internal office copy, just skip messaging their own phone.
      if (party && party.type !== 'HAMALI_TEAM') {
        phone = party.phone;
        phone2 = party.phone2;
        waLanguage = party.waLanguage;
      }
    } else if (data.brokerId) {
      const broker = await prisma.broker.findUnique({ where: { id: data.brokerId } });
      name = broker?.name ?? 'Broker';
      phone = broker?.phone ?? null;
      waLanguage = broker?.waLanguage ?? null;
    } else {
      name = data.payee || data.description || `${data.type} payment`;
    }
    await whatsappService.notifyPaymentSent(
      {
        id: payment.id,
        amount: Number(data.amount),
        date: data.date,
        reference: data.reference ?? null,
        screenshotUrl,
      },
      { name, phone, phone2, waLanguage }
    );
  })().catch(() => {});

  res.status(201).json(payment);
}

// Payments auto-posted from a detail page (Gunny Bags / Electricity /
// Maintenance / Drawings). Their journal entry is keyed to that page's own
// reference (GUNNYBAG-<id> and friends), not PAYMENT-<id>, so re-posting one
// from here would orphan the source record. Correct them where they were made.
const MANAGED_ELSEWHERE: Record<string, string> = {
  GUNNY_BAGS: 'Gunny Bags',
  ELECTRICITY: 'Electricity',
  MAINTENANCE: 'Repairs & Maintenance',
  DRAWINGS: 'Drawings',
};

/**
 * Correct a payment already on the books: the row is updated in place and its
 * journal entry is re-posted from the new values, so the ledger, the party
 * balance and every dues page follow the correction. The proof screenshot and
 * the purchase / hamali-verification links are carried over untouched, except
 * when the counterparty itself changes - a payment re-pointed at a different
 * party can no longer belong to the old party's bill, so those links are cut.
 */
export async function updatePayment(req: Request, res: Response) {
  const existing = await prisma.payment.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new HttpError(404, 'Payment not found');

  const managedIn = MANAGED_ELSEWHERE[existing.type];
  if (managedIn) {
    throw new HttpError(400, `This payment was recorded on the ${managedIn} page. Edit it there so both sides stay in sync.`);
  }

  const data = updatePaymentSchema.parse(req.body);
  if (MANAGED_ELSEWHERE[data.type]) {
    throw new HttpError(400, `${MANAGED_ELSEWHERE[data.type]} payments are recorded on their own page, not here.`);
  }

  const counterpartyChanged =
    data.type !== existing.type ||
    (data.partyId ?? null) !== existing.partyId ||
    (data.brokerId ?? null) !== existing.brokerId;

  const payment = await prisma.$transaction(async (tx) => {
    let partyName: string | undefined;
    if (data.partyId) {
      const party = await tx.party.findUnique({ where: { id: data.partyId } });
      if (!party) throw new HttpError(404, 'Party not found');
      partyName = party.name;
    }

    let brokerName: string | undefined;
    if (data.brokerId) {
      const broker = await tx.broker.findUnique({ where: { id: data.brokerId } });
      if (!broker) throw new HttpError(404, 'Broker not found');
      brokerName = broker.name;
    }

    // Unlink BEFORE deleting: Payment.journalEntry cascades on delete, so
    // dropping the entry while it is still attached would take the payment
    // row down with it.
    if (existing.journalEntryId) {
      await tx.payment.update({ where: { id: existing.id }, data: { journalEntryId: null } });
      await tx.journalEntry.delete({ where: { id: existing.journalEntryId } });
    }

    await tx.payment.update({
      where: { id: existing.id },
      data: {
        date: data.date,
        amount: data.amount,
        type: data.type,
        partyId: data.partyId ?? null,
        brokerId: data.brokerId ?? null,
        lorryNumber: data.lorryNumber ?? null,
        payee: data.payee ?? null,
        reference: data.reference ?? null,
        description: data.description ?? null,
        ...(counterpartyChanged ? { purchaseId: null, hamaliVerificationId: null } : {}),
      },
    });

    await LedgerService.postPayment(tx, existing.id, {
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
      where: { reference: `PAYMENT-${existing.id}` },
    });

    return tx.payment.update({
      where: { id: existing.id },
      data: { journalEntryId: journalEntry?.id ?? null },
      include: { party: true, broker: true },
    });
  });

  res.json(payment);
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
