import { Prisma } from '@prisma/client';

export function formatNoteNumber(prefix: string, kind: 'CN' | 'DN', serial: number, fy: string): string {
  const fyShort = fy.slice(2); // "2026-27" -> "26-27", matches invoice numbering
  return `${prefix}/${kind}/${String(serial).padStart(2, '0')}/${fyShort}`;
}

/**
 * Atomically reserves the next serial in the (seriesKey, fy) counter and
 * returns it. Mirrors reservePoSerials in poNumber.ts.
 */
export async function reserveNoteSerial(
  tx: Prisma.TransactionClient,
  seriesKey: 'CN' | 'DN',
  fy: string
): Promise<number> {
  const counter = await tx.noteSerialCounter.upsert({
    where: { seriesKey_fy: { seriesKey, fy } },
    create: { seriesKey, fy, lastSerial: 1 },
    update: { lastSerial: { increment: 1 } },
  });
  return counter.lastSerial;
}
