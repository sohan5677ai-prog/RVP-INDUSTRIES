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
export const PAPPU_OUT_TURN = 0.6; // out-turn fraction used in stock calculations
export const PAPPU_CONSUMABLE = 0.8; // Fraction of milled pappu that is consumable/sellable

// Default freight destinations (fallback before the editable rates load). The
// actual per-tonne rates live in the FreightRate table, managed in Settings.
export const SALE_DESTINATIONS = ['Surat', 'Barshi', 'Nagar'] as const;

/**
 * Round a rupee AMOUNT to whole rupees, half-up (₹100.50 → ₹101). Reserved for
 * party-ledger / payment / receipt settlement, where the ERP settles to whole
 * rupees. Costing, valuation and analytics (Order Planner, WAC, margins, P&L)
 * deliberately keep paise, so this is NOT applied to the calc helpers below.
 */
export function roundRupee(n: number): number {
  return Math.round(n || 0);
}

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

/** Hamali (unloading labour) charge in rupees. exact tonnes * rate (no tonne rounding). */
export function calcHamali(netKg: number, rate: number = DEFAULT_HAMALI_RATE, isCompanyVehicle: boolean = false): number {
  // Company vehicles no longer skip the charge entirely; the crew must still be paid,
  // but the lorry share becomes 0 and the company bears 100% of the cost.
  // Exact tonnage: 17.5 t is charged as 17.5 t, not rounded up to 18 t.
  return Math.round((netKg / 1000) * rate * 100) / 100;
}

/** Pappu (white seed) output in kg, rounded to whole kg. */
export function calcPappu(blackKg: number, outTurnPct: number = DEFAULT_OUT_TURN_PCT): number {
  return Math.round(blackKg * (outTurnPct / 100));
}

/** Total amount in rupees. finalKg * pricePerKg. */
export function calcTotal(finalKg: number, pricePerKg: number): number {
  return finalKg * pricePerKg;
}

/**
 * DELIVERY (landed) cost price of black seed, ₹/kg. The company PAYS the supplier
 * the base price, but the true cost it INCURS also carries the inward freight, so
 * every black-seed COST/valuation view (Order Planner, Stock by Party, Stock by
 * Location, Black Seed Stock, pappu margins) prices seed at this landed rate.
 * Party-facing figures (party ledger, verification, purchase dues) must keep using
 * the raw base price - that is what is actually payable.
 *
 * Formula: landed = base + (freight / freightBasisKg). `freightBasisKg` is the tonnage
 * the freight is spread across - the whole-vehicle tonnage for a SHARED lorry, or this
 * arrival's own net weight for a single-party lorry (a full lorry makes the two equal).
 * So a party's per-kg freight = totalFreight / totalTonnage, and their freight in ₹ is
 * that rate × their net weight. DELIVERY-priced POs bake freight into the quoted rate,
 * so pass freight = 0 and landed == base. Freight of 0 leaves the base price untouched.
 */
export function landedPricePerKg(basePrice: number, freightBasisKg: number, freight: number): number {
  if (!(freight > 0) || !(freightBasisKg > 0)) return basePrice;
  return Math.round((basePrice + freight / freightBasisKg) * 100) / 100;
}

/** Weighbridge fee (kata fee) based on net weight tonnage. */
export function calcKataFee(netKg: number, isCompanyVehicle: boolean = false): number {
  if (isCompanyVehicle) return 0;
  const tonnes = netKg / 1000;
  if (tonnes <= 5) return 50;
  if (tonnes <= 15) return 100;
  if (tonnes <= 25) return 150;
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
 * usage sides (crew/margin). e.g. ₹150 -> inventory 70, lorry 80, crew 140,
 * margin 10. Scales proportionally for non-default rates.
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
  const tonnes = weightKg / 1000; // exact tonnage, no rounding
  const total = round2(tonnes * rate);
  // Lorry & margin can never exceed the total they are carved out of.
  const lorry = isCompanyVehicle ? 0 : Math.min(total, round2(tonnes * lorryRate));
  const margin = Math.min(total, round2(tonnes * marginRate));
  const company = round2(total - lorry);
  const crew = round2(total - margin);
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
  const tonnes = weightKg / 1000; // exact tonnage, no rounding
  const total = round2(tonnes * rate);
  const lorry = isCompanyVehicle ? 0 : Math.min(total, round2(tonnes * lorryRate));
  const margin = Math.min(total, round2(tonnes * marginRate));
  const company = round2(total - lorry);
  const crew = round2(total - margin);
  return { total, company, lorry, crew, margin };
}

/**
 * Simple loading hamali for a byproduct (husk/TPS) at sale dispatch - flat
 * ₹/tonne, no lorry split. Used where the whole charge is either company-borne
 * or deducted off the lorry depending on the caller.
 */
export function productLoadingHamali(weightKg: number, rate: number, isCompanyVehicle: boolean = false): number {
  if (isCompanyVehicle) return 0;
  return Math.round((weightKg / 1000) * rate * 100) / 100; // exact tonnage, no rounding
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
  const charge = round2((weightKg / 1000) * rate); // exact tonnage, no rounding
  const margin = round2(charge * HAMALI_MARGIN_FRACTION);
  return { charge, crew: round2(charge - margin), margin };
}

// --- Transfer transport (billed to KNM Transport) ----------------------------
// Transfer transport is per (exact) tonne and billed to KNM Transport - for
// husk, seed (stock) and pre-cleaner-dust (shell) transfers alike. The rate is
// keyed to the storage location involved (destination for husk/dust, source for
// seed): PGR COLD / Murugan ₹250/t, KNM Multi ₹100/t. Replaces the former flat
// ₹500 per transfer.
export const TRANSFER_TRANSPORT_RATES: Record<string, number> = {
  'PGR COLD': 250,
  Murugan: 250,
  'KNM Multi': 100,
};
export const DEFAULT_TRANSFER_TRANSPORT_RATE = 250;

/** Per-tonne transfer transport rate for a storage location (₹/tonne). */
export function transferTransportRate(location: string | null | undefined): number {
  if (!location) return DEFAULT_TRANSFER_TRANSPORT_RATE;
  return TRANSFER_TRANSPORT_RATES[location.trim()] ?? DEFAULT_TRANSFER_TRANSPORT_RATE;
}

/** Transfer transport charge in rupees: exact tonnes × the location's rate (no tonne rounding). */
export function transferTransportCharge(weightKg: number, location: string | null | undefined): number {
  const tonnes = weightKg / 1000; // exact tonnage, no rounding
  return Math.round(tonnes * transferTransportRate(location) * 100) / 100;
}

// --- Stock transfer (storage → process) hamali -------------------------------
// Load + process-unload hamali is ₹270/t (exact tonnes), fully crew (no
// margin); the storage-unload leg (formerly ₹80/t) is no longer charged. Both
// the hamali and the per-tonne transfer transport are capitalised into the seed
// at the process.
export const TRANSFER_HANDLING_RATE = 270; // ₹/tonne - load + unload combined, all crew

export interface TransferHamali {
  unloadCharge: number; // storage unload leg - no longer charged, always 0
  handlingCharge: number; // load + unload combined
  charge: number; // total hamali capitalised (== handlingCharge)
  crew: number; // total paid to the crew
  margin: number; // company hamali profit - no longer applicable, always 0
}

/**
 * Hamali breakdown for one storage→process stock transfer. Tonnes are exact.
 * The ₹/tonne (`rate`, default ₹270/t) is configurable in Settings and is
 * charged in full to the crew - the storage-unload leg is not charged.
 */
export function transferHamali(
  weightKg: number,
  rate: number = TRANSFER_HANDLING_RATE
): TransferHamali {
  const tonnes = weightKg / 1000; // exact tonnage, no rounding
  const charge = Math.round(tonnes * rate * 100) / 100;
  return { unloadCharge: 0, handlingCharge: charge, charge, crew: charge, margin: 0 };
}

// --- Byproduct transfer cost (shell / husk / pre-cleaner dust) ----------------
// A production byproduct moved to a storage location for later sale. Packing +
// loading + unloading hamali is ₹333/tonne; transport is per-tonne, billed to
// KNM Transport at the location's rate (see transferTransportCharge). Both are
// capitalised into the byproduct's value at the destination.
export const SHELL_HAMALI_RATE = 333; // ₹/tonne - packing + loading + unloading

export interface ShellTransferCost {
  hamaliCharge: number;
  transportCharge: number;
  totalCost: number;
}

/**
 * Cost breakdown for one byproduct transfer to `location`. Tonnes are exact.
 * The packing+loading+unloading hamali ₹/tonne (`rate`, default ₹333/t) is
 * configurable in Settings; transport is per-tonne by location (₹250/t for
 * PGR COLD / Murugan, ₹100/t for KNM Multi), billed to KNM Transport.
 */
export function shellTransferCost(
  weightKg: number,
  rate: number = SHELL_HAMALI_RATE,
  location: string = 'PGR COLD'
): ShellTransferCost {
  const tonnes = weightKg / 1000; // exact tonnage, no rounding
  const hamaliCharge = Math.round(tonnes * rate * 100) / 100;
  const transportCharge = transferTransportCharge(weightKg, location);
  return { hamaliCharge, transportCharge, totalCost: round2(hamaliCharge + transportCharge) };
}

// --- Bank-loan carrying interest ---------------------------------------------
// Black seed sitting in a storage location is funded by bank loans. When it is
// moved storage→process, the interest accrued on its value while it sat in
// storage is capitalised into the seed (like the other transfer costs). Interest
// is accrued PER LOT by its own storage dwell time (arrival→transfer days) at the
// global annual rate, so it reflects how long each lot actually sat in storage.

/** Whole days between two dates (clamped to ≥ 0). */
export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 86_400_000));
}

/** Carrying interest on a value: value × rate% × days/365, rounded to paise. */
export function loanInterest(value: number, ratePct: number, days: number): number {
  return Math.round(value * (ratePct / 100) * (days / 365) * 100) / 100;
}

/** One lot's slice drawn at a transfer: its ex-GST landed value and the date it
 * arrived at the storage location it is now being moved out of. */
export interface DrawnSeedSlice {
  value: number; // ex-GST landed value drawn from this lot
  arrivalDate: Date; // when this lot arrived at the storage location
}

/**
 * Bank-loan carrying interest capitalised onto seed at transfer, accrued PER LOT
 * by actual storage dwell time (each slice's arrival→transfer days) at the global
 * annual `ratePct`. Returns the total interest (paise-rounded) and the
 * value-weighted average dwell days (for display on the transfer row).
 */
export function storageSeedInterest(
  slices: DrawnSeedSlice[],
  ratePct: number,
  transferDate: Date
): { interest: number; weightedDays: number } {
  let interest = 0;
  let valueDays = 0;
  let totalValue = 0;
  for (const s of slices) {
    const days = daysBetween(s.arrivalDate, transferDate);
    interest += loanInterest(s.value, ratePct, days);
    valueDays += s.value * days;
    totalValue += s.value;
  }
  return {
    interest: Math.round(interest * 100) / 100,
    weightedDays: totalValue > 0 ? Math.round(valueDays / totalValue) : 0,
  };
}


