import { Prisma } from '@prisma/client';
import { computeFY, derivePartyPrefix, normalizeSeriesKey } from './poNumber.js';

/**
 * Sale order numbering: `RVP-<NICK>/<NN>/<FY>`, e.g. `RVP-SOH/05/2627`.
 *
 *  - NICK is the BUYER's Party.nickname, uppercased - the same handle the PO
 *    series already uses, so one party reads the same in both directions.
 *  - NN is that buyer's own sequence within the financial year, zero-padded to
 *    two and left to grow past it naturally (05, 47, 112).
 *  - FY is the COMPACT form, "2627". The PO series writes "26-27"; the
 *    difference is deliberate, so a number quoted over the phone says at once
 *    whether it is a purchase or a sale. Do not "fix" one to match the other.
 *
 * The leading `RVP-` is part of the stored series key rather than glued on at
 * format time, so the counter is keyed by exactly the string that appears in
 * the number.
 */

/** Compact FY for the sale series: 2026-07-15 -> "2627". */
export function computeSaleFy(date: Date): string {
  return computeFY(date).replace('-', '');
}

/**
 * Series key for a buyer: "RVP-" + their nickname, or initials derived from the
 * name when no nickname is set (same fallback the PO series uses, so a party
 * nobody has nicknamed still gets a stable, readable series instead of none).
 */
export function saleSeriesKeyForBuyer(buyer: { name: string; nickname?: string | null }): string {
  const nick = buyer.nickname && buyer.nickname.trim()
    ? normalizeSeriesKey(buyer.nickname)
    : derivePartyPrefix(buyer.name);
  return `RVP-${nick}`;
}

export function formatSaleOrderNumber(seriesKey: string, serial: number, fy: string): string {
  return `${seriesKey}/${String(serial).padStart(2, '0')}/${fy}`;
}

/**
 * Atomically reserves the next serial in the (seriesKey, fy) series. Must run
 * inside the same transaction as the SaleOrder row it numbers, so a counter can
 * never move for an order that then fails to write.
 */
export async function reserveSaleSerial(
  tx: Prisma.TransactionClient,
  seriesKey: string,
  fy: string
): Promise<number> {
  const counter = await tx.saleSerialCounter.upsert({
    where: { seriesKey_fy: { seriesKey, fy } },
    create: { seriesKey, fy, lastSerial: 1 },
    update: { lastSerial: { increment: 1 } },
  });
  return counter.lastSerial;
}

/**
 * After a sale order is deleted, roll the counter back if (and only if) the
 * deleted order held the highest serial in its series+FY, so the next order
 * reuses the freed tail number. Interior gaps are left alone - closing one
 * would hand two orders the same number.
 */
export async function releaseSaleSerial(
  tx: Prisma.TransactionClient,
  seriesKey: string,
  fy: string
): Promise<void> {
  const highest = await tx.saleOrder.aggregate({
    where: { orderSeriesKey: seriesKey, orderFy: fy },
    _max: { orderSerial: true },
  });
  const newLast = highest._max.orderSerial ?? 0;
  if (newLast === 0) {
    await tx.saleSerialCounter.deleteMany({ where: { seriesKey, fy } });
  } else {
    await tx.saleSerialCounter.updateMany({
      where: { seriesKey, fy, lastSerial: { gt: newLast } },
      data: { lastSerial: newLast },
    });
  }
}

/**
 * Allocate a full order number for a buyer on a date. Convenience wrapper for
 * the create paths - returns the four columns SaleOrder stores.
 */
export async function allocateSaleOrderNumber(
  tx: Prisma.TransactionClient,
  buyer: { name: string; nickname?: string | null },
  saleDate: Date
): Promise<{ orderNumber: string; orderSeriesKey: string; orderSerial: number; orderFy: string }> {
  const orderSeriesKey = saleSeriesKeyForBuyer(buyer);
  const orderFy = computeSaleFy(saleDate);
  const orderSerial = await reserveSaleSerial(tx, orderSeriesKey, orderFy);
  return {
    orderNumber: formatSaleOrderNumber(orderSeriesKey, orderSerial, orderFy),
    orderSeriesKey,
    orderSerial,
    orderFy,
  };
}
