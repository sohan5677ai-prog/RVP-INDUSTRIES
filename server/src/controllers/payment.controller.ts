import { logger } from '../lib/logger.js';
import type { Request, Response } from 'express';
import type { WaLanguage } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { createPaymentSchema, listPaymentsSchema, updatePaymentSchema } from '../schemas/payment.schema.js';
import { LedgerService } from '../services/ledger.service.js';
import { extractTransactionData } from '../lib/gemini.js';
import { uploadFileToStorage } from '../lib/upload.js';
import { whatsappService, type LorryPaymentDetails } from '../services/whatsapp.service.js';
import { calcKataFee, calcHamali, pappuLoadingHamali, findCompanyVehicle } from '../lib/calc.js';

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
  const { skip, take, all, excludeSetOffs } = listPaymentsSchema.parse(req.query);
  const include = { party: true, broker: true };
  // The register is a record of money leaving the bank, so it drops set-off legs
  // (no cash moved). Dues/FIFO callers pass neither flag and still see them.
  const where = excludeSetOffs === 'true' ? { setOffId: null } : {};

  // all=true → the whole history as a plain array. The Purchase Dues / Payment
  // Planner / ledger pages match payments to bills via FIFO across a supplier's
  // FULL payment history, so they must never be capped. This shape is unchanged.
  if (all === 'true') {
    const payments = await prisma.payment.findMany({ where, orderBy: { date: 'desc' }, include });
    res.json(payments);
    return;
  }

  // Otherwise a server-paginated page for the Payments register: return just the
  // requested slice plus the grand total, so the page renders a server-driven
  // pager instead of downloading every payment on first load.
  const [rows, total] = await Promise.all([
    prisma.payment.findMany({ where: { setOffId: null }, skip, take, orderBy: { date: 'desc' }, include }),
    prisma.payment.count({ where: { setOffId: null } }),
  ]);
  res.json({ rows, total });
}

async function resolveLorryPaymentDetails(data: {
  date: Date;
  amount: number;
  reference?: string | null;
  lorryNumber?: string | null;
  description?: string | null;
  purchaseId?: string | null;
  tripId?: string | null;
  driverPhone?: string | null;
  driverName?: string | null;
  screenshotUrl?: string | null;
}): Promise<{ details: LorryPaymentDetails; phone: string | null; name: string } | null> {
  const lorryNo = data.lorryNumber?.trim() || null;
  if (!lorryNo) return null;

  // Try extracting tripId from explicit field or fallback from description [tripId] or purchaseId
  let tripId: string | null = data.tripId || data.purchaseId || null;
  if (!tripId && data.description) {
    const m = data.description.match(/\[([a-zA-Z0-9_\-]+)\]/);
    if (m) tripId = m[1];
  }

  let grossFreight = 0;
  let kata = 0;
  let hamali = 0;
  let otherDeductions = 0;
  let netPayable = 0;
  let destination = '-';
  let phone: string | null = data.driverPhone?.trim() || null;
  let name = data.driverName?.trim() ? `${data.driverName.trim()} (Lorry ${lorryNo})` : `Transporter (Lorry ${lorryNo})`;

  let foundTrip = false;

  // 1. Try SaleDispatch by ID
  if (tripId && !tripId.startsWith('husk-') && !tripId.startsWith('seed-') && !tripId.startsWith('dust-')) {
    const dispatch = await prisma.saleDispatch.findUnique({
      where: { id: tripId },
      include: { saleOrder: { include: { buyer: true } }, transport: true },
    }).catch(() => null);

    if (dispatch) {
      foundTrip = true;
      grossFreight = Number(dispatch.freightCharge || 0);
      const isCompany = false;
      const defaultKata = calcKataFee(dispatch.weightKg, isCompany);
      kata = dispatch.customKata != null ? Number(dispatch.customKata) : defaultKata;

      const isPappu = dispatch.saleOrder?.product === 'PAPPU';
      const defaultHamali = isPappu ? pappuLoadingHamali(dispatch.weightKg).lorry : calcHamali(dispatch.weightKg);
      hamali = dispatch.customHamali != null ? Number(dispatch.customHamali) : defaultHamali;

      const transportRet = dispatch.customRetention != null ? Number(dispatch.customRetention) : (dispatch.transportProvider === 'SURYA' ? 3000 : 0);
      const deductions = Array.isArray(dispatch.freightDeductions)
        ? (dispatch.freightDeductions as any[]).reduce((s, d) => s + (Number(d.amount) || 0), 0)
        : 0;
      const additions = Array.isArray(dispatch.freightAdditions)
        ? (dispatch.freightAdditions as any[]).reduce((s, a) => s + (Number(a.amount) || 0), 0)
        : 0;

      otherDeductions = Math.max(0, transportRet + deductions - additions);
      netPayable = Math.round((grossFreight + additions - (kata + hamali + transportRet + deductions)) * 100) / 100;
      destination = dispatch.saleOrder?.destination || dispatch.saleOrder?.buyer?.city || '-';
      if (!phone) phone = dispatch.driverPhone || dispatch.transport?.phone || null;
      if (dispatch.driverName && !data.driverName) name = `${dispatch.driverName} (Lorry ${lorryNo})`;
    }
  }

  // 2. Try Purchase by ID or if not found
  if (!foundTrip) {
    let purchase = tripId ? await prisma.purchase.findUnique({
      where: { id: tripId },
      include: { stockIn: { include: { purchaseOrder: { include: { party: true } } } }, verification: true },
    }).catch(() => null) : null;

    if (!purchase && lorryNo) {
      purchase = await prisma.purchase.findFirst({
        where: { stockIn: { lorryNumber: { equals: lorryNo, mode: 'insensitive' } } },
        include: { stockIn: { include: { purchaseOrder: { include: { party: true } } } }, verification: true },
        orderBy: { createdAt: 'desc' },
      });
    }

    if (purchase) {
      foundTrip = true;
      const rawFreight = Number(purchase.freightCharge ?? 0);
      const basis = Number(purchase.freightTonnageKg ?? purchase.stockIn?.freightTonnageKg ?? 0);
      const net = Number(purchase.netWeightKg ?? 0);
      grossFreight = basis > 0 && net > 0 ? (rawFreight * net) / basis : rawFreight;
      kata = purchase.customKata != null ? Number(purchase.customKata) : Number(purchase.kataFee || 0);
      hamali = purchase.customHamali != null ? Number(purchase.customHamali) : Number(purchase.hamaliCharge || 0);
      const ret = purchase.customRetention != null ? Number(purchase.customRetention) : 0;
      const deductions = Array.isArray(purchase.freightDeductions)
        ? (purchase.freightDeductions as any[]).reduce((s, d) => s + (Number(d.amount) || 0), 0)
        : 0;
      const additions = Array.isArray(purchase.freightAdditions)
        ? (purchase.freightAdditions as any[]).reduce((s, a) => s + (Number(a.amount) || 0), 0)
        : 0;
      otherDeductions = Math.max(0, ret + deductions - additions);
      netPayable = Math.round((grossFreight + additions - (kata + hamali + ret + deductions)) * 100) / 100;
      destination = purchase.stockIn?.loadingLocation || 'Punganur';
      if (!phone) phone = (purchase.stockIn as any)?.driverPhone || null;
    }
  }

  // 3. Try SaleDispatch latest if still not found
  if (!foundTrip && lorryNo) {
    const dispatch = await prisma.saleDispatch.findFirst({
      where: { vehicleNumber: { equals: lorryNo, mode: 'insensitive' } },
      include: { saleOrder: { include: { buyer: true } }, transport: true },
      orderBy: { dispatchDate: 'desc' },
    });
    if (dispatch) {
      foundTrip = true;
      grossFreight = Number(dispatch.freightCharge || 0);
      kata = dispatch.customKata != null ? Number(dispatch.customKata) : calcKataFee(dispatch.weightKg, false);
      const isPappu = dispatch.saleOrder?.product === 'PAPPU';
      hamali = dispatch.customHamali != null ? Number(dispatch.customHamali) : (isPappu ? pappuLoadingHamali(dispatch.weightKg).lorry : calcHamali(dispatch.weightKg));
      const transportRet = dispatch.customRetention != null ? Number(dispatch.customRetention) : (dispatch.transportProvider === 'SURYA' ? 3000 : 0);
      const deductions = Array.isArray(dispatch.freightDeductions)
        ? (dispatch.freightDeductions as any[]).reduce((s, d) => s + (Number(d.amount) || 0), 0)
        : 0;
      const additions = Array.isArray(dispatch.freightAdditions)
        ? (dispatch.freightAdditions as any[]).reduce((s, a) => s + (Number(a.amount) || 0), 0)
        : 0;
      otherDeductions = Math.max(0, transportRet + deductions - additions);
      netPayable = Math.round((grossFreight + additions - (kata + hamali + transportRet + deductions)) * 100) / 100;
      destination = dispatch.saleOrder?.destination || dispatch.saleOrder?.buyer?.city || '-';
      if (!phone) phone = dispatch.driverPhone || dispatch.transport?.phone || null;
      if (dispatch.driverName && !data.driverName) name = `${dispatch.driverName} (Lorry ${lorryNo})`;
    }
  }

  // 4. Fallback search for Driver Phone from TransportConfirmation / CompanyVehicles:
  if (!phone && lorryNo) {
    const norm = lorryNo.replace(/\s+/g, '').toLowerCase();
    const confirmations = await prisma.transportConfirmation.findMany({
      where: { lorryNumber: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }).catch(() => []);
    const booking = confirmations.find(
      (b) => b.lorryNumber && b.lorryNumber.replace(/\s+/g, '').toLowerCase() === norm && (b.driverPhone || b.driverName)
    );
    if (booking?.driverPhone) {
      phone = booking.driverPhone;
      if (booking.driverName && !data.driverName) name = `${booking.driverName} (Lorry ${lorryNo})`;
    }
  }

  if (!phone && lorryNo) {
    const company = await prisma.companyProfile.findFirst().catch(() => null);
    const cv = findCompanyVehicle((company as any)?.companyVehicles, lorryNo);
    if (cv?.driverPhone) {
      phone = cv.driverPhone;
      if (cv.driverName && !data.driverName) name = `${cv.driverName} (Lorry ${lorryNo})`;
    }
  }

  // 5. If still no trip found, fallback cleanly
  if (!foundTrip) {
    grossFreight = data.amount;
    netPayable = data.amount;
    destination = '-';
  }

  // Sum all payments for this lorry
  const paymentsForLorry = await prisma.payment.findMany({
    where: { lorryNumber: { equals: lorryNo, mode: 'insensitive' } },
    select: { amount: true },
  });
  const totalPaid = paymentsForLorry.reduce((s, p) => s + Number(p.amount || 0), 0);
  const balance = Math.max(0, Math.round((netPayable - totalPaid) * 100) / 100);

  return {
    details: {
      date: data.date,
      lorryNumber: lorryNo,
      destination,
      grossFreight,
      kata,
      hamali,
      otherDeductions,
      netPayable,
      amountPaid: data.amount,
      reference: data.reference ?? null,
      balance,
      screenshotUrl: data.screenshotUrl,
    },
    phone,
    name,
  };
}

export async function createPayment(req: Request, res: Response) {
  const data = createPaymentSchema.parse(req.body);

  const cleanDescription = data.description
    ? data.description.replace(/\s*\[[a-zA-Z0-9_\-]+\]\s*/g, ' ').trim() || null
    : null;

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
        description: cleanDescription,
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
      description: cleanDescription ?? undefined,
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

    const isLorryPayment = !!data.lorryNumber || data.type === 'TRANSPORTER_INWARD' || data.type === 'TRANSPORTER_OUTWARD' || data.type === 'TRANSPORTER';

    if (isLorryPayment) {
      const lorryRes = await resolveLorryPaymentDetails({
        date: data.date,
        amount: Number(data.amount),
        reference: data.reference ?? null,
        lorryNumber: data.lorryNumber ?? null,
        description: cleanDescription,
        purchaseId: data.purchaseId ?? null,
        tripId: data.tripId ?? null,
        driverPhone: data.driverPhone ?? null,
        driverName: data.driverName ?? null,
        screenshotUrl,
      });

      if (lorryRes) {
        if (data.partyId) {
          const party = await prisma.party.findUnique({ where: { id: data.partyId } });
          if (party) {
            phone = party.phone;
            phone2 = party.phone2;
            waLanguage = party.waLanguage;
          }
        }
        await whatsappService.notifyLorryPaymentSent(
          {
            id: payment.id,
            amount: Number(data.amount),
            date: data.date,
            reference: data.reference ?? null,
            screenshotUrl,
          },
          lorryRes.details,
          {
            name: lorryRes.name,
            phone: phone || lorryRes.phone,
            phone2,
            waLanguage,
          }
        );
        return;
      }
    }

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
    } else if (data.lorryNumber) {
      name = data.payee || `Lorry ${data.lorryNumber}`;
    } else {
      name = data.payee || cleanDescription || `${data.type} payment`;
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

  // Half of a two-legged knock-off. Editing it here would move the payable side
  // without the receivable side and re-open exactly the imbalance a set-off
  // exists to prevent - so corrections go through the set-off itself.
  if (existing.setOffId) {
    throw new HttpError(400, 'This is the payment side of a set-off. Reverse the set-off and record it again to change it.');
  }

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

    const cleanDescription = data.description
      ? data.description.replace(/\s*\[[a-zA-Z0-9_\-]+\]\s*/g, ' ').trim() || null
      : null;

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
        description: cleanDescription,
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
      description: cleanDescription ?? undefined,
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

  // Deleting one leg would leave the sale invoice cleared and the purchase bill
  // open again, against a contra entry that still stands. Both legs come out
  // together, via the set-off.
  if (payment.setOffId) {
    throw new HttpError(400, 'This is the payment side of a set-off. Reverse the set-off to remove both sides together.');
  }

  await prisma.$transaction(async (tx) => {
    if (payment.journalEntryId) {
      await tx.journalEntry.delete({ where: { id: payment.journalEntryId } });
    } else {
      await tx.payment.delete({ where: { id: payment.id } });
    }
  });

  res.json({ message: 'Payment deleted' });
}
