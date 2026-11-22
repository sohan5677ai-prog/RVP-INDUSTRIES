import { prisma } from './prisma.js';
import { calcAssociationFee } from './calc.js';
export { calcAssociationFee };

/**
 * What we owe a transport agency for one trip, and what comes off it.
 *
 * Two agreements live here, and they are deliberately separate from the
 * per-tonne `FreightRate` table that costing and the order planner read:
 *
 *  - **An agreed trip rate card per destination.** Madhupuri quotes three
 *    figures a lane: a lump sum for a full 35 t lorry, a second lump sum for a
 *    30 t one, and a per-tonne rate for anything smaller. The lump sums are
 *    per lorry, not per tonne - Punganur to Ausa is ₹63,000 whether the kata
 *    says 35.00 t or 34.21 t. Dividing the agreed figure by 35 and multiplying
 *    it back by the weight that actually left would short-pay him on every
 *    trip that fell light, by a few hundred rupees each time and invisibly.
 *    Only a genuine part load - under 30 t - is paid by weight.
 *  - **A mandatory per-trip association fee.** ₹300 a lorry, which was being
 *    typed onto each dispatch by hand. Where the agency carries one it is not
 *    optional: it goes on at dispatch and the Freight Dues editor will not let
 *    it be removed.
 *
 * Both are read off the Transport row rather than matched on its name. The
 * house transporter is "Sree Madhupuri Transport" in one place and "Madhupuri
 * Transport" in another, and a feature that only works while a name is spelled
 * a particular way is a feature that silently stops working.
 */

/** The label the mandatory fee is always written under. Matched on, so fixed. */
export const ASSOCIATION_FEE_LABEL = 'Lorry association fee';

export interface FreightCostItem {
  label: string;
  amount: number;
}

/**
 * Fold a destination down to the key a rate is filed under.
 *
 * Upper case, letters only, and the renamed town folded onto one spelling:
 * Ahmednagar became Ahilyanagar in 2024 and both are typed on our own orders,
 * so a rate agreed for one has to answer for the other. Everything else is
 * left alone - two towns that merely look alike must not share a rate.
 */
export function freightDestinationKey(destination: string | null | undefined): string {
  const k = String(destination ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!k) return '';
  if (k === 'AHMEDNAGAR' || k === 'AHILYANAGAR' || k === 'NAGAR') return 'AHILYANAGAR';
  if (k === 'SAHADA' || k === 'SHAHADA') return 'SHAHADA';
  return k;
}

/** The three figures a lane's rate card carries. Amounts in ₹, tonnage in kg. */
export interface TripRateCard {
  /** Lump sum for a full lorry (the agreed 35 t figure). */
  flatAmount: number;
  /** Lump sum for a 30 t lorry, where one was agreed. */
  amount30?: number | null;
  /** ₹ per tonne for a part load, where one was agreed. */
  perTonneBelow30?: number | null;
}

/**
 * Where a 35 t booking stops being a 35 t booking.
 *
 * A full lorry is booked at 35 t and the kata always comes in a little under -
 * 34.2 t is an ordinary full load, not a part load, and paying it by weight
 * would short-pay the agency on nearly every trip. Anything from here up is
 * therefore the full flat rate.
 */
const FULL_LOAD_KG = 34_000;

/** Where the 30 t lump sum stops. Below this the lane is paid by weight. */
const MID_LOAD_KG = 30_000;

/**
 * What one trip on this lane is worth at this weight, or null when the card
 * cannot answer.
 *
 * The tiers are the agreement, read in the order it was given:
 *
 *  - **34 t and up** - the full-lorry lump sum, undivided.
 *  - **30 t to 34 t** - the 30 t lump sum. A lorry that genuinely loaded 31 t
 *    is not a full lorry, and the agency quoted a separate figure for it.
 *  - **under 30 t** - a part load, paid per tonne on the weight that moved.
 *    The per-tonne figure is set so that 30 t lands on (or just under) the
 *    30 t lump sum, which is why the tiers meet instead of jumping.
 *
 * Null rather than zero wherever the card is silent: a lane with no 30 t
 * figure, or no per-tonne figure, must leave the existing per-tonne freight
 * formula alone rather than zero a trip.
 *
 * With no weight at all the full-lorry rate answers, which is what every
 * caller got before the card had tiers.
 */
export function tripFreightForWeight(
  card: TripRateCard,
  weightKg?: number | null,
): number | null {
  const full = Number(card.flatAmount) || 0;
  const atLeast = (n: number | null | undefined) => {
    const v = Number(n) || 0;
    return v > 0 ? v : null;
  };

  const kg = Number(weightKg);
  if (!Number.isFinite(kg) || kg <= 0) return atLeast(full);
  if (kg >= FULL_LOAD_KG) return atLeast(full);
  if (kg >= MID_LOAD_KG) return atLeast(card.amount30) ?? atLeast(full);

  const perTonne = atLeast(card.perTonneBelow30);
  // No part-load figure agreed: the lane falls back to its lump sum rather
  // than inventing a rate, which is how it behaved before the card had tiers.
  if (perTonne == null) return atLeast(card.amount30) ?? atLeast(full);
  return Math.round(perTonne * (kg / 1000) * 100) / 100;
}

/**
 * The agreed rate for this agency's lorry to this destination at this weight,
 * or null.
 *
 * Null is the ordinary answer - most lanes are still settled per tonne, and a
 * missing rate must leave the existing formula alone rather than zero a trip's
 * freight. Matching is done in memory over the agency's own handful of rows so
 * the fold above applies to both sides of the comparison; a `where` on the
 * stored string would miss "Nagar" against a rate filed as "Ahilyanagar".
 *
 * `weightKg` is the weight the trip is being paid on - the booked tonnage
 * where the register has one, otherwise the kata. Omit it and the full-lorry
 * rate answers.
 */
export async function flatTripFreight(
  transportId: string | null | undefined,
  destination: string | null | undefined,
  weightKg?: number | null,
): Promise<number | null> {
  const want = freightDestinationKey(destination);
  if (!transportId || !want) return null;
  const rates = await prisma.transportFreightRate.findMany({
    where: { transportId },
    select: {
      destination: true,
      flatAmount: true,
      amount30: true,
      perTonneBelow30: true,
    },
  });
  for (const rate of rates) {
    if (freightDestinationKey(rate.destination) !== want) continue;
    // A rate row left at zero is an unfinished edit, not an agreement to carry
    // a lorry for nothing - tripFreightForWeight answers null for it.
    return tripFreightForWeight(
      {
        flatAmount: Number(rate.flatAmount),
        amount30: rate.amount30 == null ? null : Number(rate.amount30),
        perTonneBelow30: rate.perTonneBelow30 == null ? null : Number(rate.perTonneBelow30),
      },
      weightKg,
    );
  }
  return null;
}

/** The agency's per-trip association fee in ₹, or 0 where it carries none. */
export async function associationFeePerTrip(
  transportId: string | null | undefined,
  weightKg?: number | null,
): Promise<number> {
  if (!transportId) return 0;
  const transport = await prisma.transport.findUnique({
    where: { id: transportId },
    select: { associationFeePerTrip: true },
  });
  const fee = Number(transport?.associationFeePerTrip ?? 0);
  return calcAssociationFee(fee, weightKg);
}

/** Read a dispatch's stored freightDeductions JSON into a usable list. */
export function readCostItems(raw: unknown): FreightCostItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((d) => {
      const row = d as { label?: unknown; amount?: unknown };
      return { label: String(row?.label ?? '').trim(), amount: Number(row?.amount) || 0 };
    })
    .filter((d) => d.label !== '');
}

/**
 * The deduction list with the agency's association fee present exactly once,
 * at the agreed amount.
 *
 * Idempotent, and re-asserted on every write rather than only at dispatch: the
 * fee's whole point is that it cannot be forgotten, and an editor that can save
 * the list back is an editor that can drop a line out of it. An existing line
 * at the wrong amount is corrected in place so the ledger shows one fee, not
 * two.
 *
 * `fee` of 0 removes nothing - an agency that stops carrying the fee leaves the
 * trips already settled under it alone.
 */
export function withAssociationFee(items: FreightCostItem[], fee: number): FreightCostItem[] {
  if (!(fee > 0)) return items;
  const label = ASSOCIATION_FEE_LABEL.toUpperCase();
  const out = items.map((d) =>
    d.label.toUpperCase() === label ? { label: ASSOCIATION_FEE_LABEL, amount: fee } : d,
  );
  if (!out.some((d) => d.label.toUpperCase() === label)) {
    out.push({ label: ASSOCIATION_FEE_LABEL, amount: fee });
  }
  return out;
}
