import { prisma } from './prisma.js';

/**
 * What we owe a transport agency for one trip, and what comes off it.
 *
 * Two agreements live here, and they are deliberately separate from the
 * per-tonne `FreightRate` table that costing and the order planner read:
 *
 *  - **A flat trip rate per destination.** Madhupuri's fleet is all
 *    35-tonners and the rate was agreed per lorry, not per tonne - Punganur to
 *    Ausa is ₹63,000 whether the kata says 35.00 t or 34.21 t. Dividing the
 *    agreed figure by 35 and multiplying it back by the weight that actually
 *    left would short-pay him on every trip that fell light, by a few hundred
 *    rupees each time and invisibly.
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

/**
 * The agreed flat rate for this agency's lorry to this destination, or null.
 *
 * Null is the ordinary answer - most lanes are still settled per tonne, and a
 * missing rate must leave the existing formula alone rather than zero a trip's
 * freight. Matching is done in memory over the agency's own handful of rows so
 * the fold above applies to both sides of the comparison; a `where` on the
 * stored string would miss "Nagar" against a rate filed as "Ahilyanagar".
 */
export async function flatTripFreight(
  transportId: string | null | undefined,
  destination: string | null | undefined,
): Promise<number | null> {
  const want = freightDestinationKey(destination);
  if (!transportId || !want) return null;
  const rates = await prisma.transportFreightRate.findMany({
    where: { transportId },
    select: { destination: true, flatAmount: true },
  });
  for (const rate of rates) {
    if (freightDestinationKey(rate.destination) !== want) continue;
    const amount = Number(rate.flatAmount);
    // A rate row left at zero is an unfinished edit, not an agreement to carry
    // a lorry for nothing.
    return amount > 0 ? amount : null;
  }
  return null;
}

/** The agency's per-trip association fee in ₹, or 0 where it carries none. */
export async function associationFeePerTrip(
  transportId: string | null | undefined,
): Promise<number> {
  if (!transportId) return 0;
  const transport = await prisma.transport.findUnique({
    where: { id: transportId },
    select: { associationFeePerTrip: true },
  });
  const fee = Number(transport?.associationFeePerTrip ?? 0);
  return fee > 0 ? fee : 0;
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
