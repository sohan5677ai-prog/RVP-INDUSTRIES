import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { createSetOffSchema, listSetOffsSchema } from '../schemas/setOff.schema.js';
import { LedgerService } from '../services/ledger.service.js';

// ---------------------------------------------------------------------------
// Party set-off (contra / knock-off).
//
// For a party we both buy from and sell to, a purchase payable and a sale
// receivable are routinely squared against each other instead of two bank
// transfers crossing. Recorded as a plain "payment made" that posts ONE leg, it
// silences Purchase Dues but strands the sale invoice open forever and leaves a
// receivable in the party ledger that will never be collected.
//
// So a set-off writes BOTH legs and no cash:
//   • a Payment leg per purchase bill  → Purchase Dues clears it (FIFO/direct)
//   • a Receipt leg per sale invoice   → Sale Dues clears it (invoice-linked)
//   • one contra journal entry, Dr 20100 / Cr 10100, with no bank line.
// The legs are equal and opposite, so the party's ledger balance is unchanged -
// which is the correct outcome: netting settles documents, it does not move the
// net position.
// ---------------------------------------------------------------------------

/** Whole rupees - the ERP carries no paise on party balances. */
function r(n: number): number {
  return Math.round(n);
}

const DUST_TAG = (dustId: string) => `DUST:${dustId}:`;

/**
 * What this party still owes us and what we still owe them, bill by bill.
 *
 * The purchase side reproduces the Purchase Dues allocation exactly (direct
 * purchaseId-linked payments first, then the floating pool in date order), and
 * the sale side reproduces Sale Dues (a shipment is cleared only by receipts
 * carrying its own dispatch id, counting cash + TDS + shortage). Both must agree
 * with those pages or the dialog would offer to knock off an amount the page
 * says is already settled.
 */
async function buildOpenItems(partyId: string) {
  const party = await prisma.party.findUnique({ where: { id: partyId } });
  if (!party) throw new HttpError(404, 'Party not found');

  const [purchases, dustPurchases, payments, saleOrders, receipts] = await Promise.all([
    prisma.purchase.findMany({
      where: { stockIn: { purchaseOrder: { partyId } }, verification: { isNot: null } },
      include: { verification: true, stockIn: true },
    }),
    prisma.dustPurchase.findMany({ where: { partyId } }),
    prisma.payment.findMany({ where: { partyId, type: 'SUPPLIER' }, orderBy: { date: 'asc' } }),
    prisma.saleOrder.findMany({ where: { buyerId: partyId }, include: { dispatches: true } }),
    prisma.receipt.findMany({ where: { partyId, type: 'BUYER' } }),
  ]);

  // ── Purchase side ────────────────────────────────────────────────────────
  const bills = purchases
    .map((p) => ({
      id: p.id,
      arrivalTime: new Date(p.stockIn?.arrivalDate ?? p.createdAt).getTime(),
      arrivalDate: (p.stockIn?.arrivalDate ?? p.createdAt).toISOString(),
      invoiceNumber: p.stockIn?.invoiceNumber ?? null,
      lorryNumber: p.stockIn?.lorryNumber ?? null,
      totalAmount: r(Number(p.verification!.totalAmount)),
      remaining: r(Number(p.verification!.totalAmount)),
    }))
    .sort((a, b) => a.arrivalTime - b.arrivalTime);

  const isDustRef = (ref?: string | null) => !!ref && ref.startsWith('DUST:');

  // Direct (bill-linked) payments settle their own bill first.
  for (const bill of bills) {
    for (const pay of payments.filter((x) => x.purchaseId === bill.id)) {
      if (bill.remaining <= 0) break;
      bill.remaining = Math.max(0, bill.remaining - r(Number(pay.amount)));
    }
  }

  // Then the floating pool, oldest payment first, against bills that existed on
  // the payment date; any surplus rolls onto later bills (advance payments).
  const floating = payments
    .filter((p) => !p.purchaseId && !isDustRef(p.reference))
    .map((p) => ({ available: r(Number(p.amount)), payTime: new Date(p.date).getTime() }))
    .sort((a, b) => a.payTime - b.payTime);

  for (const pay of floating) {
    for (const bill of bills) {
      if (pay.available <= 0) break;
      if (bill.remaining <= 0 || bill.arrivalTime > pay.payTime) continue;
      const applied = Math.min(pay.available, bill.remaining);
      pay.available -= applied;
      bill.remaining -= applied;
    }
    for (const bill of bills) {
      if (pay.available <= 0) break;
      if (bill.remaining <= 0) continue;
      const applied = Math.min(pay.available, bill.remaining);
      pay.available -= applied;
      bill.remaining -= applied;
    }
  }

  const openPurchases = [
    ...bills
      .filter((b) => b.remaining > 0)
      .map((b) => ({
        kind: 'GRAIN' as const,
        id: b.id,
        date: b.arrivalDate,
        invoiceNumber: b.invoiceNumber,
        lorryNumber: b.lorryNumber,
        totalAmount: b.totalAmount,
        outstanding: b.remaining,
      })),
    ...dustPurchases
      .map((d) => {
        const total = r(Number(d.amount));
        const paid = payments
          .filter((p) => p.reference?.startsWith(DUST_TAG(d.id)))
          .reduce((s, p) => s + r(Number(p.amount)), 0);
        return {
          kind: 'DUST' as const,
          id: d.id,
          date: d.purchaseDate.toISOString(),
          invoiceNumber: d.invoiceNumber ?? null,
          lorryNumber: d.lorryNumber ?? null,
          totalAmount: total,
          outstanding: Math.max(0, total - paid),
        };
      })
      .filter((d) => d.outstanding > 0),
  ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  // ── Sale side ────────────────────────────────────────────────────────────
  const settled = new Map<string, number>();
  for (const rec of receipts) {
    if (!rec.saleDispatchId) continue;
    const amt = Number(rec.amount) + Number(rec.tdsAmount ?? 0) + Number(rec.shortageAmount ?? 0);
    settled.set(rec.saleDispatchId, (settled.get(rec.saleDispatchId) ?? 0) + amt);
  }

  const openSales = saleOrders
    .flatMap((so) =>
      so.dispatches.map((d) => {
        const total = r(d.weightKg * Number(so.ratePerKg)) + r(Number(d.gstAmount));
        // Sub-₹1 remainders are rounding noise between whole-rupee bills and
        // paise-carrying TDS/shortage - the same tolerance isDispatchPaid uses.
        const outstanding = r(total - (settled.get(d.id) ?? 0));
        return {
          saleDispatchId: d.id,
          date: d.dispatchDate.toISOString(),
          invoiceNumber:
            d.invoiceNumber ?? (d.invoiceSeq && d.invoiceFy ? `${d.invoiceSeq}/${d.invoiceFy}` : null),
          vehicleNumber: d.vehicleNumber,
          product: so.product,
          totalAmount: total,
          outstanding,
        };
      })
    )
    .filter((d) => d.outstanding > 0)
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  return {
    party: { id: party.id, name: party.name },
    purchases: openPurchases,
    sales: openSales,
    totals: {
      payable: openPurchases.reduce((s, p) => s + p.outstanding, 0),
      receivable: openSales.reduce((s, d) => s + d.outstanding, 0),
    },
  };
}

type OpenItems = Awaited<ReturnType<typeof buildOpenItems>>;

export async function getSetOffOpenItems(req: Request, res: Response) {
  res.json(await buildOpenItems(req.params.partyId));
}

export async function listSetOffs(req: Request, res: Response) {
  const { partyId } = listSetOffsSchema.parse(req.query);
  const rows = await prisma.partySetOff.findMany({
    where: partyId ? { partyId } : undefined,
    orderBy: { date: 'desc' },
    include: {
      party: { select: { id: true, name: true } },
      payments: { select: { id: true, amount: true, purchaseId: true, reference: true } },
      receipts: { select: { id: true, amount: true, saleDispatchId: true } },
    },
  });
  res.json(rows);
}

export async function createSetOff(req: Request, res: Response) {
  const data = createSetOffSchema.parse(req.body);

  const purchaseTotal = data.purchases.reduce((s, p) => s + p.amount, 0);
  const saleTotal = data.sales.reduce((s, d) => s + d.amount, 0);
  if (purchaseTotal !== saleTotal) {
    throw new HttpError(
      400,
      `A set-off must balance: ₹${purchaseTotal} allocated to purchase bills vs ₹${saleTotal} to sale invoices.`
    );
  }
  if (purchaseTotal <= 0) throw new HttpError(400, 'Nothing to set off');

  for (const list of [data.purchases.map((p) => `${p.kind}:${p.id}`), data.sales.map((d) => d.saleDispatchId)]) {
    if (new Set(list).size !== list.length) {
      throw new HttpError(400, 'The same bill appears more than once in this set-off');
    }
  }

  // Re-derive what is actually open right now, from the same source the dues
  // pages read, so a stale dialog can never over-allocate a bill.
  const open = await buildOpenItems(data.partyId);
  const openPurchaseById = new Map<string, OpenItems['purchases'][number]>(
    open.purchases.map((p) => [`${p.kind}:${p.id}`, p])
  );
  const openSaleById = new Map<string, OpenItems['sales'][number]>(
    open.sales.map((d) => [d.saleDispatchId, d])
  );

  for (const leg of data.purchases) {
    const bill = openPurchaseById.get(`${leg.kind}:${leg.id}`);
    if (!bill) {
      throw new HttpError(400, 'A purchase bill in this set-off is no longer open for this party. Reload and try again.');
    }
    if (leg.amount > bill.outstanding) {
      throw new HttpError(
        400,
        `₹${leg.amount} exceeds the ₹${bill.outstanding} still outstanding on purchase bill ${bill.invoiceNumber ?? bill.id}.`
      );
    }
  }
  for (const leg of data.sales) {
    const inv = openSaleById.get(leg.saleDispatchId);
    if (!inv) {
      throw new HttpError(400, 'A sale invoice in this set-off is no longer open for this party. Reload and try again.');
    }
    if (leg.amount > inv.outstanding) {
      throw new HttpError(
        400,
        `₹${leg.amount} exceeds the ₹${inv.outstanding} still outstanding on sale invoice ${inv.invoiceNumber ?? inv.saleDispatchId}.`
      );
    }
  }

  const setOff = await prisma.$transaction(async (tx) => {
    const party = await tx.party.findUnique({ where: { id: data.partyId } });
    if (!party) throw new HttpError(404, 'Party not found');

    const created = await tx.partySetOff.create({
      data: {
        date: data.date,
        partyId: data.partyId,
        amount: purchaseTotal,
        note: data.note ?? null,
      },
    });

    const saleLabels = data.sales
      .map((s) => openSaleById.get(s.saleDispatchId)?.invoiceNumber)
      .filter(Boolean)
      .join(', ');
    const purchaseLabels = data.purchases
      .map((p) => openPurchaseById.get(`${p.kind}:${p.id}`)?.invoiceNumber)
      .filter(Boolean)
      .join(', ');

    // Payment-side legs. They carry NO journalEntryId: the single contra entry
    // below is the whole accounting effect, and posting each leg the normal way
    // would credit the bank for cash that never left.
    for (const leg of data.purchases) {
      await tx.payment.create({
        data: {
          date: data.date,
          amount: leg.amount,
          type: 'SUPPLIER',
          partyId: data.partyId,
          setOffId: created.id,
          // A dust bill has no Purchase row to point at, so it is settled by the
          // same `DUST:<id>:<mode>` reference tag the Purchase Dues page matches.
          ...(leg.kind === 'DUST'
            ? { reference: `${DUST_TAG(leg.id)}SET-OFF` }
            : { purchaseId: leg.id, reference: 'SET-OFF' }),
          description: `Set-off against sale invoice${saleLabels ? ` ${saleLabels}` : 's'} (no cash paid)`,
        },
      });
    }

    // Receipt-side legs, one per sale invoice - invoice-based settlement means a
    // shipment is only ever cleared by a receipt stamped with its dispatch id.
    for (const leg of data.sales) {
      await tx.receipt.create({
        data: {
          date: data.date,
          amount: leg.amount,
          type: 'BUYER',
          partyId: data.partyId,
          saleDispatchId: leg.saleDispatchId,
          setOffId: created.id,
          reference: 'SET-OFF',
          description: `Set-off against purchase bill${purchaseLabels ? ` ${purchaseLabels}` : 's'} (no cash received)`,
        },
      });
    }

    const entry = await LedgerService.postSetOff(tx, created.id, {
      date: data.date,
      amount: purchaseTotal,
      partyName: party.name,
      note: data.note ?? undefined,
    });

    return tx.partySetOff.update({
      where: { id: created.id },
      data: { journalEntryId: entry.id },
      include: { party: { select: { id: true, name: true } }, payments: true, receipts: true },
    });
  });

  res.status(201).json(setOff);
}

/**
 * Reverse a set-off in full. Both legs and the contra entry go together - there
 * is no such thing as unwinding half a knock-off, which is exactly the mess this
 * feature exists to prevent.
 */
export async function deleteSetOff(req: Request, res: Response) {
  const existing = await prisma.partySetOff.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new HttpError(404, 'Set-off not found');

  await prisma.$transaction(async (tx) => {
    // Deleting the set-off cascades its Payment / Receipt legs away.
    await tx.partySetOff.delete({ where: { id: existing.id } });
    if (existing.journalEntryId) {
      await tx.journalEntry.delete({ where: { id: existing.journalEntryId } });
    }
  });

  res.json({ message: 'Set-off reversed' });
}
