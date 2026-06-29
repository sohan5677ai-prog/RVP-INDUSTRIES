// RVP core domain math. Pure functions — no I/O, no rounding surprises.
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
export function calcHamali(netKg: number, rate: number = DEFAULT_HAMALI_RATE, isCompanyVehicle: boolean = false): number {
  if (isCompanyVehicle) return 0;
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
  if (tonnes <= 25) return 150;
  return 200;
}

/** The company's share of the hamali charge (the half we actually bear). */
export function companyHamaliShare(hamaliCharge: number): number {
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
export function hamaliSplit(hamaliCharge: number): HamaliSplit {
  const inventory = round2(hamaliCharge * COMPANY_HAMALI_SHARE);
  const lorry = round2(hamaliCharge - inventory);
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

export function pappuLoadingHamali(weightKg: number, isCompanyVehicle: boolean = false): LoadingHamaliSplit {
  if (isCompanyVehicle) return { total: 0, company: 0, lorry: 0, crew: 0, margin: 0 };
  const tonnes = Math.round(weightKg / 1000);
  const total = tonnes * PAPPU_LOADING_HAMALI_RATE;
  const company = tonnes * PAPPU_LOADING_HAMALI_COMPANY_RATE;
  const lorry = tonnes * PAPPU_LOADING_HAMALI_LORRY_RATE;
  const margin = tonnes * PAPPU_LOADING_HAMALI_MARGIN_RATE;
  const crew = total - margin;
  return { total, company, lorry, crew, margin };
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
//   - storage unload leg: ₹80/t, split ₹70 crew + ₹10 company profit
//   - load + process-unload (combined): ₹270/t, fully crew (no margin)
//   - transport: a fixed ₹500 per transfer (not per tonne)
// Everything is 100% company-borne and capitalised into the seed at the process.
export const TRANSFER_STORAGE_UNLOAD_RATE = 80; // ₹/tonne (₹70 crew + ₹10 margin)
export const TRANSFER_STORAGE_UNLOAD_MARGIN = 10; // ₹/tonne company profit on the unload leg
export const TRANSFER_HANDLING_RATE = 270; // ₹/tonne — load + unload combined, all crew
export const TRANSFER_TRANSPORT = 500; // ₹ fixed per transfer

export interface TransferHamali {
  unloadCharge: number; // storage unload leg (₹80/t)
  handlingCharge: number; // load + unload combined (₹270/t)
  charge: number; // total hamali capitalised (unload + handling)
  crew: number; // total paid to the crew
  margin: number; // company hamali profit (the ₹10/t on the unload leg)
}

/** Hamali breakdown for one storage→process stock transfer. Tonnes are rounded. */
export function transferHamali(weightKg: number): TransferHamali {
  const tonnes = Math.round(weightKg / 1000);
  const unloadCharge = tonnes * TRANSFER_STORAGE_UNLOAD_RATE;
  const margin = tonnes * TRANSFER_STORAGE_UNLOAD_MARGIN;
  const handlingCharge = tonnes * TRANSFER_HANDLING_RATE;
  const charge = unloadCharge + handlingCharge;
  return { unloadCharge, handlingCharge, charge, crew: charge - margin, margin };
}

// --- Tamarind shell transfer (process → Rampalli) ----------------------------
// Shell is a production byproduct moved to the Rampalli storage for later sale.
// Packing + loading + unloading hamali is ₹333/tonne; transport is a fixed ₹500.
// Both are capitalised into the shell's value at Rampalli.
export const SHELL_HAMALI_RATE = 333; // ₹/tonne — packing + loading + unloading at Rampalli
export const SHELL_TRANSPORT = 500; // ₹ fixed per transfer

export interface ShellTransferCost {
  hamaliCharge: number;
  transportCharge: number;
  totalCost: number;
}

/** Cost breakdown for one process→Rampalli shell transfer. Tonnes are rounded. */
export function shellTransferCost(weightKg: number): ShellTransferCost {
  const tonnes = Math.round(weightKg / 1000);
  const hamaliCharge = tonnes * SHELL_HAMALI_RATE;
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


