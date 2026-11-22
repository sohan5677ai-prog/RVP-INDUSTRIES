import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import {
  flatTripFreight,
  freightDestinationKey,
  tripFreightForWeight,
} from '../lib/transportFreight.js';
import { WAITING_STATES } from './lorryConfirmation.service.js';

/**
 * Madhupuri Transport's agreed rate card, as quoted by the agency in November
 * 2026: a lump sum for a full 35 t lorry, a second for a 30 t one, and a
 * per-tonne figure for any part load under 30 t.
 *
 * Kept in code because it is the card the office works from and it had been
 * living in people's heads - the register was carrying a freight on the lanes
 * someone had typed a rate for and leaving the column blank on the rest.
 */
export const MADHUPURI_RATE_CARD: Array<{
  destination: string;
  flatAmount: number;
  amount30: number;
  perTonneBelow30: number;
}> = [
  { destination: 'SHAHADA', flatAmount: 80_000, amount30: 69_000, perTonneBelow30: 2_300 },
  { destination: 'SURAT', flatAmount: 80_000, amount30: 70_000, perTonneBelow30: 2_300 },
  { destination: 'SILVASSA', flatAmount: 80_000, amount30: 70_000, perTonneBelow30: 2_300 },
  { destination: 'AHILYANAGAR', flatAmount: 66_500, amount30: 57_000, perTonneBelow30: 1_900 },
  { destination: 'BARSHI', flatAmount: 56_000, amount30: 48_000, perTonneBelow30: 1_600 },
  { destination: 'AUSA', flatAmount: 63_000, amount30: 54_000, perTonneBelow30: 1_800 },
];

/**
 * Put the quoted card on Madhupuri's lanes, once.
 *
 * Only ever writes a lane whose tier figures are still unset - that is what
 * "has never been given the card" looks like. A lane the office later edits in
 * Settings, Transports is left exactly as the office left it, because a seed
 * that re-stamps itself on every restart is a seed that quietly reverses the
 * person who corrected it.
 *
 * The one thing it does overwrite on such a lane is the old single flat
 * amount, which was entered before the card existed and disagrees with it
 * (Barshi was filed at ₹52,500 against the quoted ₹56,000).
 */
export async function applyMadhupuriRateCard(): Promise<number> {
  const madhupuri = await prisma.transport.findFirst({
    where: { name: { contains: 'adhupuri', mode: 'insensitive' } },
    select: { id: true },
  });
  if (!madhupuri) return 0;

  const existing = await prisma.transportFreightRate.findMany({
    where: { transportId: madhupuri.id },
    select: { id: true, destination: true, amount30: true, perTonneBelow30: true },
  });
  const byKey = new Map(existing.map((r) => [freightDestinationKey(r.destination), r]));

  let written = 0;
  for (const lane of MADHUPURI_RATE_CARD) {
    const row = byKey.get(freightDestinationKey(lane.destination));
    if (row && (row.amount30 != null || row.perTonneBelow30 != null)) continue;
    if (row) {
      await prisma.transportFreightRate.update({
        where: { id: row.id },
        data: {
          flatAmount: lane.flatAmount,
          amount30: lane.amount30,
          perTonneBelow30: lane.perTonneBelow30,
          forTonnageKg: 35_000,
        },
      });
    } else {
      await prisma.transportFreightRate.create({
        data: { transportId: madhupuri.id, ...lane, forTonnageKg: 35_000 },
      });
    }
    written += 1;
  }
  if (written) {
    logger.info(`[boot] applied the Madhupuri trip rate card to ${written} lane(s)`);
  }
  return written;
}

/**
 * Fill the freight on waiting bookings that never got one.
 *
 * A message that arrived without a requirement code used to be filed with an
 * empty freight column: nothing had resolved which agency it was, so the rate
 * card was never read. Those rows are still waiting, so the figure can be put
 * on them now and the dispatch they eventually match will carry it through.
 *
 * Deliberately only WAITING outbound rows. A booking that has already gone out
 * was settled at whatever the dispatch recorded, and back-dating a freight
 * onto it would disagree with the ledger.
 */
export async function backfillBookingFreight(): Promise<number> {
  const rows = await prisma.transportConfirmation.findMany({
    where: {
      freightAmount: null,
      direction: 'OUTBOUND',
      status: { in: [...WAITING_STATES] },
    },
    select: { id: true, toPlace: true, tonnageKg: true, fromPhone: true, dispatchSlotId: true },
  });
  if (!rows.length) return 0;

  // One pass over the agencies, not one lookup per row: a phone number is the
  // only thing most of these rows carry and the agency list is tiny.
  const transports = await prisma.transport.findMany({
    where: { active: true },
    select: { id: true, phone: true, phone2: true },
  });
  const last10 = (v: string | null | undefined) => String(v ?? '').replace(/\D/g, '').slice(-10);
  const byPhone = new Map<string, string>();
  for (const t of transports) {
    for (const phone of [t.phone, t.phone2]) {
      const key = last10(phone);
      if (key.length === 10) byPhone.set(key, t.id);
    }
  }

  let filled = 0;
  for (const row of rows) {
    let transportId = byPhone.get(last10(row.fromPhone)) ?? null;
    if (!transportId && row.dispatchSlotId) {
      const slot = await prisma.dispatchSlot.findUnique({
        where: { id: row.dispatchSlotId },
        select: { transportId: true },
      });
      transportId = slot?.transportId ?? null;
    }
    const amount = await flatTripFreight(transportId, row.toPlace, row.tonnageKg);
    if (amount == null) continue;
    await prisma.transportConfirmation.update({
      where: { id: row.id },
      data: { freightAmount: amount },
    });
    filled += 1;
  }
  if (filled) {
    logger.info(`[boot] filled the agreed freight on ${filled} waiting lorry booking(s)`);
  }
  return filled;
}

/** Both one-time passes, run at boot. Never throws - neither is load-bearing. */
export async function syncTransportRateCards(): Promise<void> {
  try {
    await applyMadhupuriRateCard();
    await backfillBookingFreight();
  } catch (err) {
    logger.error('[boot] could not sync the transport rate cards', err);
  }
}

// Re-exported so a caller that only wants the arithmetic does not have to know
// where the lookup lives.
export { tripFreightForWeight };
