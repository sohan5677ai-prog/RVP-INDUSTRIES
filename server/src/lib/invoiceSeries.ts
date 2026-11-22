import type { Prisma, PrismaClient } from '@prisma/client';

/** Either the main client or a `$transaction` client - both expose the models used here. */
type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Highest invoice sequence already consumed in a series/financial year.
 *
 * "Consumed" is wider than "currently on a shipment": a number that was raised
 * and later withdrawn (dispatch undone, IRN cancelled) is burnt for good and is
 * parked in VoidInvoiceNumber. Counting those stops the allocator from handing
 * a cancelled number out again, which the NIC portal rejects with error 2278.
 */
export async function maxConsumedInvoiceSeq(
  db: Db,
  series: string,
  fy: string,
): Promise<number> {
  const [live, voided] = await Promise.all([
    db.saleDispatch.aggregate({
      where: { invoiceFy: fy, invoiceSeries: series },
      _max: { invoiceSeq: true },
    }),
    db.voidInvoiceNumber.aggregate({
      where: { invoiceFy: fy, invoiceSeries: series },
      _max: { invoiceSeq: true },
    }),
  ]);
  return Math.max(live._max.invoiceSeq ?? 0, voided._max.invoiceSeq ?? 0);
}

/**
 * The sequence the next invoice in this series/FY should take: one past
 * everything consumed so far, but never below the floor an admin configured in
 * Settings (which is how a number cancelled outside the ERP is skipped).
 */
export async function nextInvoiceSeq(
  db: Db,
  series: string,
  fy: string,
  configuredFloor: number,
): Promise<number> {
  const consumed = await maxConsumedInvoiceSeq(db, series, fy);
  return Math.max(configuredFloor, consumed + 1);
}

/** Display form of an invoice number, e.g. ("RVP", 190, "2026-27") -> "RVP/190/26-27". */
export function formatInvoiceNumber(prefix: string, seq: number, fy: string): string {
  return `${prefix}/${String(seq).padStart(2, '0')}/${fy.slice(2)}`;
}
