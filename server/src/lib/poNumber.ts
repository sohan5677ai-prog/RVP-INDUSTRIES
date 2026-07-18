import { Prisma } from '@prisma/client';

/**
 * Financial year label for a date, e.g. 2026-07-15 -> "26-27" (FY runs Apr-Mar).
 */
export function computeFY(date: Date): string {
  const year = date.getFullYear();
  const month = date.getMonth(); // 0-indexed; April = 3
  const startYear = month >= 3 ? year : year - 1;
  const yy = (n: number) => String(n % 100).padStart(2, '0');
  return `${yy(startYear)}-${yy(startYear + 1)}`;
}

/**
 * Normalizes a nickname/prefix into the series key used for PO numbers:
 * uppercase, alphanumeric only.
 */
export function normalizeSeriesKey(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Fallback series key derived from a party name when no nickname is set,
 * e.g. "Malola Narasimha Traders" -> "MNT", "DCS" -> "DCS".
 */
export function derivePartyPrefix(partyName: string): string {
  const words = partyName.trim().split(/\s+/);
  if (words.length > 1) {
    const initials = normalizeSeriesKey(words.map((w) => w[0]).join(''));
    if (initials.length >= 2) return initials;
  }
  return normalizeSeriesKey(partyName.slice(0, 3));
}

export function formatPoNumber(seriesKey: string, serial: number, fy: string): string {
  return `${seriesKey}/${String(serial).padStart(2, '0')}/${fy}`;
}

export function formatPoRange(seriesKey: string, startSerial: number, endSerial: number, fy: string): string {
  if (startSerial === endSerial) return formatPoNumber(seriesKey, startSerial, fy);
  return `${seriesKey}/${String(startSerial).padStart(2, '0')}-${String(endSerial).padStart(2, '0')}/${fy}`;
}

/**
 * Atomically reserves `count` consecutive serials in the (seriesKey, fy) series
 * and returns the first one reserved. Must run inside the same transaction as
 * the PurchaseOrder rows being created so the counter and the numbers it backs
 * stay consistent.
 */
export async function reservePoSerials(
  tx: Prisma.TransactionClient,
  seriesKey: string,
  fy: string,
  count: number
): Promise<number> {
  const counter = await tx.poSerialCounter.upsert({
    where: { seriesKey_fy: { seriesKey, fy } },
    create: { seriesKey, fy, lastSerial: count },
    update: { lastSerial: { increment: count } },
  });
  return counter.lastSerial - count + 1;
}
