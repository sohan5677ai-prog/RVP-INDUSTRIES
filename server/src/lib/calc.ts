// RVP core domain math. Pure functions — no I/O, no rounding surprises.
// IMPORTANT: keep this file identical to client/src/lib/calc.ts.
//
// Units:
//   - weights: kg (integer)
//   - price per tonne: rupees (number)
//   - amounts: rupees (number)

export const EXEMPT_KG = 80;
export const DEFAULT_HAMALI_RATE = 160; // ₹ per tonne (full unloading charge)
// Half of the hamali is paid by the lorry/transporter; the company bears the
// other half. Only the company's share is capitalised into inventory value.
export const COMPANY_HAMALI_SHARE = 0.5;
export const DEFAULT_OUT_TURN_PCT = 60; // black -> white yield

export interface CrossVerifyResult {
  reference: number;
  diff: number;
  exempt: boolean;
  finalWeight: number;
}

/**
 * Weight cross-verification (spec section 4).
 *
 * Step 1: pick the reference weight.
 *   party_kata == billing_weight -> reference = billing_weight
 *   party_kata != billing_weight -> reference = party_kata
 *
 * Step 2: compare reference against RVP_kata (absolute difference).
 *   diff == 0      -> pay at reference, not exempt
 *   diff <= 80     -> pay at reference, exempt
 *   diff  > 80     -> pay at reference - (diff - 80), not exempt
 *
 * BUSINESS RULE TO CONFIRM (open question #1): this uses Math.abs, so it
 * deducts even when RVP weighed MORE than the reference. If RVP confirms
 * deduction should only apply when RVP weighs LESS, change `diff` to
 * `reference - rvpKata` and only penalize when diff > 0. Spec-as-written
 * for now.
 */
export function crossVerify(
  billingWeight: number,
  partyKata: number,
  rvpKata: number
): CrossVerifyResult {
  const reference = partyKata === billingWeight ? billingWeight : partyKata;
  const diff = reference - rvpKata; // positive if rvpKata is lighter than reference

  let finalWeight: number;
  let exempt: boolean;

  if (diff <= 0) {
    finalWeight = reference;
    exempt = true;
  } else if (diff <= EXEMPT_KG) {
    finalWeight = reference; // within 80kg -> exempted, pay at reference
    exempt = true;
  } else {
    finalWeight = reference - (diff - EXEMPT_KG); // deduct overage beyond 80kg
    exempt = false;
  }

  return { reference, diff: Math.max(0, diff), exempt, finalWeight };
}

/** Hamali (unloading labour) charge in rupees. rounded tonnes * rate. */
export function calcHamali(netKg: number, rate: number = DEFAULT_HAMALI_RATE): number {
  return Math.round(netKg / 1000) * rate;
}

/** Pappu (white seed) output in kg, rounded to whole kg. */
export function calcPappu(blackKg: number, outTurnPct: number = DEFAULT_OUT_TURN_PCT): number {
  return Math.round(blackKg * (outTurnPct / 100));
}

/** Total amount in rupees. finalKg * pricePerKg. */
export function calcTotal(finalKg: number, pricePerKg: number): number {
  return finalKg * pricePerKg;
}

/** Weighbridge fee (kata fee) based on net weight tonnage. */
export function calcKataFee(netKg: number): number {
  const tonnes = netKg / 1000;
  if (tonnes <= 15) return 50;
  if (tonnes <= 25) return 150;
  return 200;
}

/** The company's share of the hamali charge (the half we actually bear). */
export function companyHamaliShare(hamaliCharge: number): number {
  return Math.round(hamaliCharge * COMPANY_HAMALI_SHARE * 100) / 100;
}
