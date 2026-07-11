// RVP core domain math. Pure functions - no I/O, no rounding surprises.
// IMPORTANT: keep this file identical to client/src/lib/calc.ts.
//
// Units:
//   - weights: kg (integer)
//   - price per tonne: rupees (number)
//   - amounts: rupees (number)

export const EXEMPT_KG = 80;
export const DEFAULT_HAMALI_RATE = 150; // ₹ per tonne (full unloading charge)
// Arrival hamali is a small profit-centre. Of the ₹150/tonne charge:
//   - funding side: lorry pays ₹80, the seed (inventory) bears ₹70
//   - usage side:   the crew is paid ₹140, the company keeps ₹10 as margin
// Only the inventory's ₹70 share is capitalised into the silo value (unchanged
// from before); the crew/margin split only affects how the ledger records it.
export const COMPANY_HAMALI_SHARE = 70 / 150; // inventory's funding share of the charge
export const HAMALI_MARGIN_FRACTION = 10 / 150; // company profit per ₹ of hamali
export const DEFAULT_OUT_TURN_PCT = 60; // black -> white yield

// Default freight destinations (fallback before the editable rates load). The
// actual per-tonne rates live in the FreightRate table, managed in Settings.
export const SALE_DESTINATIONS = ['Surat', 'Barshi', 'Nagar'] as const;

/** Outward freight in rupees: ratePerTonne × tonnes. */
export function calcSaleFreight(weightKg: number, ratePerTonne: number): number {
  return Math.round((weightKg / 1000) * (ratePerTonne || 0) * 100) / 100;
}

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
 * Step 2: compare reference against RVP_kata.
 *   diff <= 0      -> pay at RVP weight, exempt (RVP weighed same or more)
 *   diff <= 80     -> pay at reference, exempt
 *   diff  > 80     -> pay at reference - (diff - 80), not exempt
 *
 * Deduction only applies when RVP weighs LESS than the reference. When RVP
 * weighs MORE than the party/billing reference we pay for the heavier RVP
 * weight.
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
    // RVP weighed at or above the party/billing reference -> pay for the
    // (heavier) RVP weight, not the lighter reference.
    finalWeight = rvpKata;
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

/** Helper to check if a vehicle is in the exempt company vehicles list */
export function isVehicleExempt(vehicleNumber: string | null | undefined, companyVehiclesList: string | null | undefined): boolean {
  if (!vehicleNumber || !companyVehiclesList) return false;
  const list = companyVehiclesList.split(/[\n,]+/).map(v => v.trim().toLowerCase()).filter(v => v);
  const target = vehicleNumber.trim().toLowerCase();
  return list.includes(target);
}

/** Hamali (unloading labour) charge in rupees. rounded tonnes * rate. */
export function calcHamali(netKg: number, rate: number = DEFAULT_HAMALI_RATE, _isCompanyVehicle: boolean = false): number {
  // Company vehicles no longer skip the charge entirely; the crew must still be paid,
  // but the lorry share becomes 0 and the company bears 100% of the cost.
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
export function calcKataFee(netKg: number, isCompanyVehicle: boolean = false): number {
  if (isCompanyVehicle) return 0;
  const tonnes = netKg / 1000;
  if (tonnes <= 15) return 50;
  if (tonnes <= 30) return 150;
  return 200;
}

/** The company's share of the hamali charge (the half we actually bear). */
export function companyHamaliShare(hamaliCharge: number, isCompanyVehicle: boolean = false): number {
  if (isCompanyVehicle) return hamaliCharge;
  return Math.round(hamaliCharge * COMPANY_HAMALI_SHARE * 100) / 100;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface HamaliSplit {
  total: number; // full charge
  inventory: number; // capitalised into seed value (funding share)
  lorry: number; // funded by the transporter (funding share)
  crew: number; // actually paid to the hamali crew
  margin: number; // company hamali profit (total - crew)
}

/**
 * Split an arrival hamali charge into its funding sides (inventory/lorry) and
 * usage sides (crew/margin). e.g. ₹160 -> inventory 80, lorry 80, crew 140,
 * margin 20. Scales proportionally for non-default rates.
 */
export function hamaliSplit(hamaliCharge: number, isCompanyVehicle: boolean = false): HamaliSplit {
  const inventory = isCompanyVehicle ? hamaliCharge : round2(hamaliCharge * COMPANY_HAMALI_SHARE);
  const lorry = isCompanyVehicle ? 0 : round2(hamaliCharge - inventory);
  const margin = round2(hamaliCharge * HAMALI_MARGIN_FRACTION);
  const crew = round2(hamaliCharge - margin);
  return { total: hamaliCharge, inventory, lorry, crew, margin };
}

// Pappu loading hamali at sale dispatch. ₹220/tonne total:
//   funding: company (us) ₹140, lorry ₹80 (collected from the driver, off freight)
//   usage:   crew ₹210 (our ₹140 + ₹70 of the lorry's ₹80), ₹10 → company P/L
export const PAPPU_LOADING_HAMALI_RATE = 220; // ₹/tonne total
export const PAPPU_LOADING_HAMALI_COMPANY_RATE = 140; // ₹/tonne our share
export const PAPPU_LOADING_HAMALI_LORRY_RATE = 80; // ₹/tonne collected from the driver
export const PAPPU_LOADING_HAMALI_MARGIN_RATE = 10; // ₹/tonne company P/L

export interface LoadingHamaliSplit {
  total: number; // full loading charge
  company: number; // our (company-borne) share
  lorry: number; // deducted from the lorry's delivery freight
  crew: number; // actually paid to the hamali crew
  margin: number; // company hamali profit → P/L
}

/**
 * Pappu loading hamali at dispatch. All three ₹/tonne rates are configurable in
 * Settings (defaults ₹220/t total, ₹80/t lorry-collected, ₹10/t company margin).
 * company = total − lorry, crew = total − margin.
 */
export function pappuLoadingHamali(
  weightKg: number,
  isCompanyVehicle: boolean = false,
  rate: number = PAPPU_LOADING_HAMALI_RATE,
  lorryRate: number = PAPPU_LOADING_HAMALI_LORRY_RATE,
  marginRate: number = PAPPU_LOADING_HAMALI_MARGIN_RATE
): LoadingHamaliSplit {
  const tonnes = Math.round(weightKg / 1000);
  const total = tonnes * rate;
  // Lorry & margin can never exceed the total they are carved out of.
  const lorry = isCompanyVehicle ? 0 : Math.min(total, tonnes * lorryRate);
  const margin = Math.min(total, tonnes * marginRate);
  const company = total - lorry;
  const crew = total - margin;
  return { total, company, lorry, crew, margin };
}

/**
 * Generic loading-hamali split for a custom cost charged at Pappu dispatch - same
 * split logic as standard pappu loading but with variable rates.
 */
export function customLoadingHamali(
  weightKg: number,
  rate: number,
  lorryRate: number,
  marginRate: number,
  isCompanyVehicle: boolean = false
): LoadingHamaliSplit {
  const tonnes = Math.round(weightKg / 1000);
  const total = tonnes * rate;
  const lorry = isCompanyVehicle ? 0 : Math.min(total, tonnes * lorryRate);
  const margin = Math.min(total, tonnes * marginRate);
  const company = total - lorry;
  const crew = total - margin;
  return { total, company, lorry, crew, margin };
}

/**
 * Simple loading hamali for a byproduct (husk/TPS) at sale dispatch - flat
 * ₹/tonne, no lorry split. Used where the whole charge is either company-borne
 * or deducted off the lorry depending on the caller.
 */
export function productLoadingHamali(weightKg: number, rate: number, isCompanyVehicle: boolean = false): number {
  if (isCompanyVehicle) return 0;
  return Math.round(weightKg / 1000) * rate;
}

export interface InternalHamaliLeg {
  charge: number; // full charge for the leg, 100% company-borne
  crew: number; // paid to the crew
  margin: number; // company hamali profit
}

/**
 * One internal hamali leg (storage loading or process unloading) for a transfer.
 * No lorry to split with, so the seed bears the full charge; the crew/margin
 * split (₹140/₹20 per tonne at the default rate) still applies.
 */
export function internalHamaliLeg(
  weightKg: number,
  rate: number = DEFAULT_HAMALI_RATE,
  isCompanyVehicle: boolean = false
): InternalHamaliLeg {
  if (isCompanyVehicle) return { charge: 0, crew: 0, margin: 0 };
  const charge = Math.round(weightKg / 1000) * rate;
  const margin = round2(charge * HAMALI_MARGIN_FRACTION);
  return { charge, crew: round2(charge - margin), margin };
}

// --- Stock transfer (storage → process) hamali -------------------------------
// All charges are per (rounded) tonne unless noted:
//   - load + process-unload (combined): ₹270/t, fully crew (no margin)
//   - transport: a fixed ₹500 per transfer (not per tonne)
// The storage-unload leg (formerly ₹80/t) is no longer charged.
// Everything is 100% company-borne and capitalised into the seed at the process.
export const TRANSFER_HANDLING_RATE = 270; // ₹/tonne - load + unload combined, all crew
export const TRANSFER_TRANSPORT = 500; // ₹ fixed per transfer

export interface TransferHamali {
  unloadCharge: number; // storage unload leg - no longer charged, always 0
  handlingCharge: number; // load + unload combined
  charge: number; // total hamali capitalised (== handlingCharge)
  crew: number; // total paid to the crew
  margin: number; // company hamali profit - no longer applicable, always 0
}

/**
 * Hamali breakdown for one storage→process stock transfer. Tonnes are rounded.
 * The ₹/tonne (`rate`, default ₹270/t) is configurable in Settings and is
 * charged in full to the crew - the storage-unload leg is not charged.
 */
export function transferHamali(
  weightKg: number,
  rate: number = TRANSFER_HANDLING_RATE
): TransferHamali {
  const tonnes = Math.round(weightKg / 1000);
  const charge = tonnes * rate;
  return { unloadCharge: 0, handlingCharge: charge, charge, crew: charge, margin: 0 };
}

// --- Tamarind shell transfer (process → Rampalli) ----------------------------
// Shell is a production byproduct moved to the Rampalli storage for later sale.
// Packing + loading + unloading hamali is ₹333/tonne; transport is a fixed ₹500.
// Both are capitalised into the shell's value at Rampalli.
export const SHELL_HAMALI_RATE = 333; // ₹/tonne - packing + loading + unloading at Rampalli
export const SHELL_TRANSPORT = 500; // ₹ fixed per transfer

export interface ShellTransferCost {
  hamaliCharge: number;
  transportCharge: number;
  totalCost: number;
}

/**
 * Cost breakdown for one process→Rampalli shell transfer. Tonnes are rounded.
 * The packing+loading+unloading hamali ₹/tonne (`rate`, default ₹333/t) is
 * configurable in Settings; transport stays a fixed ₹500.
 */
export function shellTransferCost(weightKg: number, rate: number = SHELL_HAMALI_RATE): ShellTransferCost {
  const tonnes = Math.round(weightKg / 1000);
  const hamaliCharge = tonnes * rate;
  const transportCharge = SHELL_TRANSPORT;
  return { hamaliCharge, transportCharge, totalCost: hamaliCharge + transportCharge };
}

// --- Bank-loan carrying interest ---------------------------------------------
// Black seed sitting in a storage location is funded by bank loans. When it is
// moved storage→process, the interest accrued on its value while it sat in
// storage is capitalised into the seed (like the other transfer costs). Days are
// counted from the earliest open loan's drawdown date to the transfer date.

/** Whole days between two dates (clamped to ≥ 0). */
export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 86_400_000));
}

/** Carrying interest on a value: value × rate% × days/365, rounded to paise. */
export function loanInterest(value: number, ratePct: number, days: number): number {
  return Math.round(value * (ratePct / 100) * (days / 365) * 100) / 100;
}

// ── Order Planner roll-up ─────────────────────────────────────────────────────
// Black seed → pappu bridge. One out-turn (60%) converts seed to milled pappu;
// the server's /inventory/by-price endpoint already does the per-band allocation
// (sales draw-down, most-expensive-first), so this helper is a pure aggregation
// of the band figures it returns. Keeping the roll-up here means every page
// (Conversion, Black Seed Stock, Order Planner, byproduct pool) shows identical
// Remaining / Available / Committed numbers.

export const PAPPU_OUT_TURN = 0.6; // black seed → milled pappu yield

/** Minimal shape of a /inventory/by-price band consumed by {@link stockSummary}. */
export interface ByPriceBandLike {
  arrivedBlackKg: number;            // gross black seed arrived in this band
  remainingBlackKg: number;          // arrived seed left after sales draw-down
  pendingBlackKg: number;            // un-arrived seed from still-open POs (after draw-down)
  pendingConsumableBlackKg: number;  // consumable portion of the pending seed (buffer excluded)
}

export interface StockSummary {
  arrivedBlackKg: number;    // total gross seed arrived
  remainingBlackKg: number;  // on-hand seed after sales
  pendingBlackKg: number;    // still-coming seed from open POs
  committedBlackKg: number;  // on-hand + consumable pending (buffer excluded)
  availablePappuKg: number;  // remaining seed × out-turn
  committedPappuKg: number;  // committed seed × out-turn
}

/** Aggregate the by-price bands into the shared Remaining/Available/Committed roll-up. */
export function stockSummary(bands: ByPriceBandLike[] = []): StockSummary {
  const sum = (pick: (b: ByPriceBandLike) => number) =>
    bands.reduce((s, b) => s + (pick(b) || 0), 0);

  const arrivedBlackKg = sum((b) => b.arrivedBlackKg);
  const remainingBlackKg = sum((b) => b.remainingBlackKg);
  const pendingBlackKg = sum((b) => b.pendingBlackKg);
  const pendingConsumableBlackKg = sum((b) => b.pendingConsumableBlackKg);
  const committedBlackKg = remainingBlackKg + pendingConsumableBlackKg;

  return {
    arrivedBlackKg,
    remainingBlackKg,
    pendingBlackKg,
    committedBlackKg,
    availablePappuKg: Math.round(remainingBlackKg * PAPPU_OUT_TURN),
    committedPappuKg: Math.round(committedBlackKg * PAPPU_OUT_TURN),
  };
}


