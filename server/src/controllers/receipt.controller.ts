import { logger } from '../lib/logger.js';
import type { Request, Response } from 'express';
import type { WaLanguage } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { createReceiptSchema, listReceiptsSchema, updateReceiptSchema } from '../schemas/receipt.schema.js';
import { LedgerService } from '../services/ledger.service.js';
import { extractTransactionData } from '../lib/gemini.js';
import { whatsappService } from '../services/whatsapp.service.js';

/**
 * Read an uploaded receipt screenshot (bank/UPI/cheque) with Gemini and return
 * the fields it could extract, so the client can pre-fill the receipt form. The
 * counterparty here is whoever PAID US, so we offer buyers as the known-party
 * candidates for matching. Nothing is persisted.
 */
export async function extractReceiptScreenshot(req: Request, res: Response) {
  if (!req.file) throw new HttpError(400, 'Screenshot file is required');
  const buyers = await prisma.party.findMany({ where: { type: 'BUYER' }, select: { name: true } });
  const candidates = [...new Set(buyers.map((b) => b.name).filter(Boolean))];
  const data = await extractTransactionData(req.file.buffer, req.file.mimetype, 'receipt', candidates);
  logger.info('[extract:receipt]', JSON.stringify(data));
  res.json(data);
}

export async function listReceipts(req: Request, res: Response) {
  const { skip, take, all } = listReceiptsSchema.parse(req.query);
  const include = { party: true };

  // all=true → whole history as a plain array (Sale Dues / ledger FIFO matching
  // need the full set uncapped). Shape unchanged for those callers.
  if (all === 'true') {
    const receipts = await prisma.receipt.findMany({ orderBy: { date: 'desc' }, include });
    res.json(receipts);
    return;
  }

  // Server-paginated slice + grand total for the Receipts register page.
  const [rows, total] = await Promise.all([
    prisma.receipt.findMany({ skip, take, orderBy: { date: 'desc' }, include }),
    prisma.receipt.count(),
  ]);
  res.json({ rows, total });
}

export async function createReceipt(req: Request, res: Response) {
  const data = createReceiptSchema.parse(req.body);
  let partyName: string | undefined;
  let partyPhone: string | null = null;
  let partyPhone2: string | null | undefined = null;
  // Null for an "other income" payer typed free-hand - no party row, no language.
  let partyLanguage: WaLanguage | null = null;

  // Bill-wise split. One bank transfer routinely settles several invoices, but a
  // shipment is only ever cleared by receipts stamped with its own dispatch id
  // (settledByDispatch / isDispatchPaid) - so instead of parking the collection
  // on account, where it credits the party ledger but leaves every invoice
  // reading Unpaid, it is written as one Receipt row per invoice.
  const allocations = data.allocations ?? [];
  if (allocations.length > 0) {
    if (data.type !== 'BUYER' || !data.partyId) {
      throw new HttpError(400, 'Invoice-wise allocation applies to buyer collections only');
    }
    const ids = allocations.map((a) => a.saleDispatchId);
    if (new Set(ids).size !== ids.length) {
      throw new HttpError(400, 'The same invoice appears more than once in the allocation');
    }
    const allocatedCash = allocations.reduce((s, a) => s + a.amount, 0);
    if (allocatedCash !== data.amount) {
      throw new HttpError(
        400,
        `Allocated cash (${allocatedCash}) does not match the amount received (${data.amount})`
      );
    }
    if (allocations.every((a) => a.amount + a.tdsAmount + a.shortageAmount === 0)) {
      throw new HttpError(400, 'Every allocation is zero - nothing to settle');
    }
  }

  const receipts = await prisma.$transaction(async (tx) => {
    if (data.partyId) {
      const party = await tx.party.findUnique({ where: { id: data.partyId } });
      if (!party) throw new HttpError(404, 'Party not found');
      partyName = party.name;
      partyPhone = party.phone;
      partyPhone2 = party.phone2;
      partyLanguage = party.waLanguage;
    }

    if (allocations.length > 0) {
      const dispatches = await tx.saleDispatch.findMany({
        where: { id: { in: allocations.map((a) => a.saleDispatchId) } },
        include: { saleOrder: { select: { buyerId: true } } },
      });
      const byId = new Map(dispatches.map((d) => [d.id, d]));
      for (const a of allocations) {
        const d = byId.get(a.saleDispatchId);
        if (!d) throw new HttpError(404, `Invoice ${a.saleDispatchId} not found`);
        if (d.saleOrder.buyerId !== data.partyId) {
          throw new HttpError(400, `Invoice ${d.invoiceNumber ?? d.id} does not belong to this buyer`);
        }
      }
    }

    // No allocations → a single row, exactly as before (advance / on-account
    // money, or a non-buyer income receipt).
    const rows = allocations.length > 0
      ? allocations.map((a) => ({
          amount: a.amount,
          tdsAmount: a.tdsAmount || null,
          shortageAmount: a.shortageAmount || null,
          saleDispatchId: a.saleDispatchId,
        }))
      : [{
          amount: data.amount,
          tdsAmount: data.tdsAmount ?? null,
          shortageAmount: data.shortageAmount ?? null,
          saleDispatchId: data.saleDispatchId ?? null,
        }];

    const out = [];
    for (const row of rows) {
      const created = await tx.receipt.create({
        data: {
          date: data.date,
          amount: row.amount,
          tdsAmount: row.tdsAmount,
          shortageAmount: row.shortageAmount,
          type: data.type,
          partyId: data.partyId ?? null,
          saleDispatchId: row.saleDispatchId,
          payer: data.payer ?? null,
          reference: data.reference ?? null,
          description: data.description ?? null,
        },
      });

      await LedgerService.postReceipt(tx, created.id, {
        date: data.date,
        amount: row.amount,
        type: data.type,
        partyName,
        payer: data.payer ?? undefined,
        reference: data.reference ?? undefined,
        description: data.description ?? undefined,
      });

      const journalEntry = await tx.journalEntry.findFirst({
        where: { reference: `RECEIPT-${created.id}` },
      });

      out.push(
        journalEntry
          ? await tx.receipt.update({
              where: { id: created.id },
              data: { journalEntryId: journalEntry.id },
              include: { party: true },
            })
          : created
      );
    }
    return out;
  });

  // WhatsApp the payer (when we have a phone on file) and ALWAYS copy the
  // internal alert-recipient members - every receipt (buyer collections,
  // gunny/scrap/interest/other income) gets an office copy. Fire-and-forget.
  // A split collection is one payment to the buyer, so it gets one message for
  // the full amount rather than one per invoice.
  void (async () => {
    const name = partyName || data.payer || `${data.type} receipt`;
    await whatsappService.notifyReceiptReceived(
      {
        id: receipts[0].id,
        amount: Number(data.amount),
        date: data.date,
        reference: data.reference ?? null,
      },
      { name, phone: partyPhone, phone2: partyPhone2, waLanguage: partyLanguage }
    );
  })().catch(() => {});

  // Single-row creates keep their original response shape; a split returns the
  // whole set so the caller can see what each invoice took.
  res.json(allocations.length > 0 ? receipts : receipts[0]);
}

// Receipts auto-posted from a detail page. Their journal entry is keyed to that
// page's own reference, not RECEIPT-<id>, so re-posting one from here would
// orphan the source record. Correct them where they were made.
const MANAGED_ELSEWHERE: Record<string, string> = {
  GUNNY_BAGS_SALE: 'Gunny Bags',
  OTHER_INCOME: 'Other Income',
};

/**
 * Correct a receipt already on the books: the row is updated in place and its
 * journal entry is re-posted from the new values, so the ledger, the buyer
 * balance and the dues pages follow the correction.
 *
 * The invoice link and its TDS / shortage deductions are deliberately left
 * alone - settlement is invoice-based, so an edit may restate WHAT was received
 * but never re-point the money at a different bill. Reverse and re-record for
 * that. For the same reason the type and the buyer are frozen once a receipt is
 * stamped with a dispatch id.
 */
export async function updateReceipt(req: Request, res: Response) {
  const existing = await prisma.receipt.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new HttpError(404, 'Receipt not found');

  const managedIn = MANAGED_ELSEWHERE[existing.type];
  if (managedIn) {
    throw new HttpError(400, `This receipt was recorded on the ${managedIn} page. Edit it there so both sides stay in sync.`);
  }

  const data = updateReceiptSchema.parse(req.body);
  if (MANAGED_ELSEWHERE[data.type]) {
    throw new HttpError(400, `${MANAGED_ELSEWHERE[data.type]} receipts are recorded on their own page, not here.`);
  }

  if (existing.saleDispatchId) {
    if (data.type !== existing.type || (data.partyId ?? null) !== existing.partyId) {
      throw new HttpError(
        400,
        'This receipt settles a specific invoice. Reverse it and re-record it to move the money to a different buyer.'
      );
    }
    // The deductions were sized against this invoice's balance, so the cash can
    // never be raised past what the invoice still had outstanding.
    const cleared = Number(existing.tdsAmount ?? 0) + Number(existing.shortageAmount ?? 0);
    if (cleared > 0 && data.amount <= 0) {
      throw new HttpError(400, 'This receipt carries a TDS / shortage deduction, so its cash amount cannot be zeroed out.');
    }
  }

  const receipt = await prisma.$transaction(async (tx) => {
    let partyName: string | undefined;
    if (data.partyId) {
      const party = await tx.party.findUnique({ where: { id: data.partyId } });
      if (!party) throw new HttpError(404, 'Party not found');
      partyName = party.name;
    }

    // Unlink BEFORE deleting: Receipt.journalEntry cascades on delete, so
    // dropping the entry while it is still attached would take the receipt row
    // down with it.
    if (existing.journalEntryId) {
      await tx.receipt.update({ where: { id: existing.id }, data: { journalEntryId: null } });
      await tx.journalEntry.delete({ where: { id: existing.journalEntryId } });
    }

    await tx.receipt.update({
      where: { id: existing.id },
      data: {
        date: data.date,
        amount: data.amount,
        type: data.type,
        partyId: data.partyId ?? null,
        payer: data.payer ?? null,
        reference: data.reference ?? null,
        description: data.description ?? null,
      },
    });

    await LedgerService.postReceipt(tx, existing.id, {
      date: data.date,
      amount: data.amount,
      type: data.type,
      partyName,
      payer: data.payer ?? undefined,
      reference: data.reference ?? undefined,
      description: data.description ?? undefined,
    });

    const journalEntry = await tx.journalEntry.findFirst({
      where: { reference: `RECEIPT-${existing.id}` },
    });

    return tx.receipt.update({
      where: { id: existing.id },
      data: { journalEntryId: journalEntry?.id ?? null },
      include: { party: true },
    });
  });

  res.json(receipt);
}

export async function deleteReceipt(req: Request, res: Response) {
  const receipt = await prisma.receipt.findUnique({ where: { id: req.params.id } });
  if (!receipt) throw new HttpError(404, 'Receipt not found');

  await prisma.$transaction(async (tx) => {
    // A receipt raised from "Mark Paid" against a shipment also spins off SEPARATE
    // ledger postings - TDS-<dispatchId> / SHORTAGE-<dispatchId> - and stamps the
    // TDS onto the dispatch itself. None of those are children of the receipt's own
    // journal entry, so deleting the receipt alone used to strand a phantom TDS /
    // shortage on the dispatch and in the party ledger (and, now, the TDS report).
    // Reverse them here. Sale-Dues receipts carry no such postings, so these are
    // harmless no-ops there - the reference-scoped deletes match nothing.
    if (receipt.saleDispatchId) {
      if (Number(receipt.tdsAmount ?? 0) > 0) {
        await tx.journalEntry.deleteMany({ where: { reference: `TDS-${receipt.saleDispatchId}` } });
        await tx.saleDispatch.update({ where: { id: receipt.saleDispatchId }, data: { tdsAmount: null } });
      }
      if (Number(receipt.shortageAmount ?? 0) > 0) {
        // Only the ledger posting is reversed; the shortage stays recorded on the
        // dispatch (creditNoteAmount / shortageKg), matching how a delivery shortage
        // is held off the ledger until a receipt actually books the deduction.
        await tx.journalEntry.deleteMany({ where: { reference: `SHORTAGE-${receipt.saleDispatchId}` } });
      }
    }

    if (receipt.journalEntryId) {
      await tx.journalEntry.delete({ where: { id: receipt.journalEntryId } });
    } else {
      await tx.receipt.delete({ where: { id: receipt.id } });
    }
  });

  res.json({ message: 'Receipt deleted' });
}
