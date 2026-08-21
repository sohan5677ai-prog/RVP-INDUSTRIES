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

// --- Sale-order close tolerance ---------------------------------------------
// A lorry never weighs exactly what was booked: a 25 t husk order goes out at
// 24.87 t and is finished, but the arithmetic leaves 130 kg of balance that no
// future lorry will ever take. These two helpers decide when a shortfall is
// small enough to call the order complete. The percentages come from Settings
// (CompanyProfile.saleCloseTolerancePct / ...ByproductPct).
//
// The SERVER decides this for real, at dispatch. The client mirrors it only to
// know whether to ask for a deliberate "final lorry" tick - so these MUST stay
// identical to server/src/lib/calc.ts or the dialog asks at the wrong moment.

/** Default close tolerances (%) used before Settings loads / on a blank profile. */
export const DEFAULT_SALE_CLOSE_TOLERANCE_PCT = 0.5; // pappu - bagged, lands close
export const DEFAULT_SALE_CLOSE_TOLERANCE_BYPRODUCT_PCT = 2; // husk & co - loaded loose

/**
 * Pappu is bagged to a target weight; husk, waste, shell, TPS and the
 * pre-cleaner byproducts are loaded loose by volume and vary far more, so they
 * carry the wider tolerance.
 */
export function isLooseLoadedProduct(product: string): boolean {
  return product !== 'PAPPU';
}

/**
 * The shortfall (kg) an order may finish under its booked tonnage and still
 * count as fully dispatched. Always at least 1 kg so an exact-to-the-kg order
 * can never be held open by a rounding remainder.
 */
export function saleCloseToleranceKg(orderedKg: number, tolerancePct: number): number {
  return Math.max(1, Math.round((orderedKg * (tolerancePct || 0)) / 100));
}

/**
 * Is this order complete? True when the shipped weight reaches the booked
 * tonnage, or falls short of it by no more than the tolerance.
 */
export function isSaleOrderFulfilled(orderedKg: number, dispatchedKg: number, tolerancePct: number): boolean {
  return orderedKg - dispatchedKg <= saleCloseToleranceKg(orderedKg, tolerancePct);
}

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

/** One row of the KNM vehicle directory held in CompanyProfile.companyVehicles. */
export interface CompanyVehicle {
  number: string;
  driverName: string;
  driverPhone: string;
}

/**
 * Parse the KNM vehicle directory: one vehicle per line, fields pipe-separated
 * as `AP39UX9105|Ravi|9876543210`. Rows saved before the driver columns existed
 * are plain numbers (historically a comma-separated list was also accepted), so
 * a line with no pipe still parses as number-only vehicles with no driver.
 */
export function parseCompanyVehicles(companyVehiclesList: string | null | undefined): CompanyVehicle[] {
  if (!companyVehiclesList) return [];
  const out: CompanyVehicle[] = [];
  for (const line of companyVehiclesList.split('\n')) {
    if (!line.includes('|')) {
      for (const n of line.split(',')) {
        const number = n.trim();
        if (number) out.push({ number, driverName: '', driverPhone: '' });
      }
      continue;
    }
    const [number = '', driverName = '', driverPhone = ''] = line.split('|');
    if (number.trim()) out.push({ number: number.trim(), driverName: driverName.trim(), driverPhone: driverPhone.trim() });
  }
  return out;
}

/** Just the vehicle numbers, trimmed and lowercased, for membership checks. */
export function companyVehicleNumbers(companyVehiclesList: string | null | undefined): string[] {
  return parseCompanyVehicles(companyVehiclesList).map(v => v.number.toLowerCase());
}

/** Normalise a lorry number for loose matching: alphanumerics only, uppercased. */
export function normalizeLorryNumber(vehicleNumber: string | null | undefined): string {
  return (vehicleNumber ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Look a lorry up in the directory to pre-fill its driver. Matching ignores
 * spaces and hyphens (the office types `AP 39 UX 9105` as often as not); this
 * is deliberately looser than isVehicleExempt, which keeps exact matching
 * because it moves money.
 */
export function findCompanyVehicle(
  vehicleNumber: string | null | undefined,
  companyVehiclesList: string | null | undefined,
): CompanyVehicle | null {
  const target = normalizeLorryNumber(vehicleNumber);
  if (!target) return null;
  return parseCompanyVehicles(companyVehiclesList).find(v => normalizeLorryNumber(v.number) === target) ?? null;
}

/** Helper to check if a vehicle is in the exempt company vehicles list */
export function isVehicleExempt(vehicleNumber: string | null | undefined, companyVehiclesList: string | null | undefined): boolean {
  if (!vehicleNumber || !companyVehiclesList) return false;
  const target = vehicleNumber.trim().toLowerCase();
  return companyVehicleNumbers(companyVehiclesList).includes(target);
}

/** Hamali (unloading labour) charge in rupees. exact tonnes * rate (no tonne rounding). */
export function calcHamali(netKg: number, rate: number = DEFAULT_HAMALI_RATE, _isCompanyVehicle: boolean = false): number {
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

// Storage→process carrying interest is a FLAT 1% per month (= 12% p.a.), day-
// prorated by each lot's storage dwell. Fixed rate, independent of bank-loan rates.
export const STORAGE_INTEREST_MONTHLY_PCT = 1;
export const STORAGE_INTEREST_ANNUAL_PCT = STORAGE_INTEREST_MONTHLY_PCT * 12;

// ── Order Planner roll-up ─────────────────────────────────────────────────────
// Black seed → pappu bridge. One out-turn (60%) converts seed to milled pappu;
// the server's /inventory/by-price endpoint already does the per-band allocation
// (sales draw-down, most-expensive-first), so this helper is a pure aggregation
// of the band figures it returns. Keeping the roll-up here means every page
// (Conversion, Black Seed Stock, Order Planner, byproduct pool) shows identical
// Remaining / Available / Committed numbers.


/** Minimal shape of a /inventory/by-price band consumed by {@link stockSummary}. */
export interface ByPriceBandLike {
  arrivedBlackKg: number;            // gross black seed arrived in this band
  remainingBlackKg: number;          // arrived seed left after sales draw-down
  pendingBlackKg: number;            // un-arrived seed from still-open POs (after draw-down)
  pendingConsumableBlackKg: number;  // consumable portion of the pending seed (buffer excluded)
}

export interface StockSummary {
  arrivedBlackKg: number;    // total gross seed arrived
  consumedBlackKg: number;   // arrived seed already drawn by sale orders
  remainingBlackKg: number;  // on-hand seed after sales
  pendingBlackKg: number;    // still-coming seed from open POs (gross, incl. buffer)
  pendingConsumableBlackKg: number; // the sellable part of the pending seed
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
    // Only the ARRIVED side is debited by sales here: the server tracks the seed a
    // sale drew from still-coming (PENDING PO) lots separately, so pre-selling an
    // incoming lorry never reduces arrived/remaining stock at the mill.
    consumedBlackKg: Math.max(0, arrivedBlackKg - remainingBlackKg),
    remainingBlackKg,
    pendingBlackKg,
    pendingConsumableBlackKg,
    committedBlackKg,
    availablePappuKg: Math.round(remainingBlackKg * PAPPU_OUT_TURN),
    committedPappuKg: Math.round(committedBlackKg * PAPPU_OUT_TURN),
  };
}

// --- Quality adjustments (verification deductions) ---------------------------
// At approval the operator lists any number of deductions against the party's
// bill. Every row DEDUCTS; the mode decides how:
//   WEIGHT  - kg knocked off the payable weight
//   PRICE   - ₹/kg knocked off the payable rate
//   AMOUNT  - flat ₹ quality discount (booked as Purchase Discount income)
//   EXPENSE - flat ₹ cost the party bears. The exact mirror of a bill addable:
//             it lowers their payable AND the seed's landed cost.
//   FREIGHT - flat ₹ lorry freight the party bears. Recovered from them but
//             still owed to the lorry, so it stays in the seed's landed cost
//             and surfaces on Freight Dues (KNM tab for a company lorry,
//             Inward (Purchases) tab for any other).
// Any mode may repeat; same-mode rows simply add up.
//
// Keep identical to server/src/lib/calc.ts.

export type QualityAdjustmentMode = 'WEIGHT' | 'PRICE' | 'AMOUNT' | 'EXPENSE' | 'FREIGHT';

export interface QualityAdjustmentInput {
  mode: QualityAdjustmentMode;
  label?: string | null;
  value: number;
}

export interface QualityAdjustmentRow {
  mode: QualityAdjustmentMode;
  label: string;
  /** What the operator typed: kg for WEIGHT, ₹/kg for PRICE, ₹ for the rest. */
  value: number;
  /** Rupee effect on the party's payable (always a deduction). */
  amount: number;
}

export const QUALITY_ADJUSTMENT_LABELS: Record<QualityAdjustmentMode, string> = {
  WEIGHT: 'Weight Deduct',
  PRICE: 'Price Deduct',
  AMOUNT: 'Flat Amount',
  EXPENSE: 'Expense',
  FREIGHT: 'Freight',
};

export interface QualityAdjustmentResult {
  rows: QualityAdjustmentRow[];
  payableWeightKg: number;
  payablePricePerKg: number;
  /** Weight x rate after the WEIGHT/PRICE cuts, before the flat ₹ rows. */
  basePayable: number;
  /** Seed value the party is actually billed for, after every row. */
  netBaseCost: number;
  /** WEIGHT + PRICE + AMOUNT in ₹ - the quality discount (Purchase Discount). */
  discountAmount: number;
  /** EXPENSE rows in ₹ - recovered from the party, de-capitalised off the seed. */
  expenseAmount: number;
  /** FREIGHT rows in ₹ - recovered from the party, owed to the lorry instead. */
  freightAmount: number;
  /** Total ₹ knocked off the gross seed value by all rows together. */
  totalDeduction: number;
}

export function computeQualityAdjustments(
  inputs: QualityAdjustmentInput[] | null | undefined,
  finalWeightKg: number,
  pricePerKg: number,
): QualityAdjustmentResult {
  const clean = (inputs ?? []).filter((r) => Number(r.value) > 0);
  const valueOf = (mode: QualityAdjustmentMode) =>
    clean.filter((r) => r.mode === mode).reduce((s, r) => s + Number(r.value), 0);

  const payableWeightKg = Math.max(0, finalWeightKg - valueOf('WEIGHT'));
  const payablePricePerKg = Math.max(0, pricePerKg - valueOf('PRICE'));
  const basePayable = payableWeightKg * payablePricePerKg;

  // Per-row rupee effect. WEIGHT is valued at the full rate and PRICE at the
  // post-weight-cut tonnage, so the rows sum EXACTLY to
  // (finalWeightKg * pricePerKg) - basePayable - no drift between the printed
  // breakdown and the total.
  const rows: QualityAdjustmentRow[] = clean.map((r) => {
    const value = Number(r.value);
    const amount =
      r.mode === 'WEIGHT' ? value * pricePerKg
      : r.mode === 'PRICE' ? value * payableWeightKg
      : value;
    return {
      mode: r.mode,
      label: (r.label ?? '').trim() || QUALITY_ADJUSTMENT_LABELS[r.mode],
      value,
      amount: round2(amount),
    };
  });

  const amountOf = (mode: QualityAdjustmentMode) =>
    rows.filter((r) => r.mode === mode).reduce((s, r) => s + r.amount, 0);

  const discountAmount = round2(amountOf('WEIGHT') + amountOf('PRICE') + amountOf('AMOUNT'));
  const expenseAmount = round2(amountOf('EXPENSE'));
  const freightAmount = round2(amountOf('FREIGHT'));
  const netBaseCost = Math.max(0, basePayable - amountOf('AMOUNT') - expenseAmount - freightAmount);

  return {
    rows,
    payableWeightKg,
    payablePricePerKg,
    basePayable,
    netBaseCost,
    discountAmount,
    expenseAmount,
    freightAmount,
    totalDeduction: round2(finalWeightKg * pricePerKg - netBaseCost),
  };
}

/** Total ₹ of the FREIGHT rows on a stored quality-adjustment list. */
export function qualityAdjustmentFreight(
  rows: QualityAdjustmentRow[] | null | undefined,
): number {
  return round2(
    (rows ?? [])
      .filter((r) => r?.mode === 'FREIGHT')
      .reduce((s, r) => s + (Number(r.amount) || 0), 0),
  );
}

// --- Product HSN resolution (with buyer-specific overrides) ------------------

/**
 * Krishi Nutrition Company Pvt Ltd requires HSN code 11063010 constant in all invoices / EWBs.
 */
export const KRISHI_HSN = '11063010';

/**
 * Returns true if the buyer is Krishi Nutrition Company Pvt Ltd (matching by GSTIN or name).
 */
export function isKrishiNutritionBuyer(
  buyer?: { name?: string | null; gstin?: string | null } | null | string,
): boolean {
  if (!buyer) return false;
  if (typeof buyer === 'string') {
    const s = buyer.toLowerCase().trim();
    return s.includes('krishi');
  }
  const name = (buyer.name || '').toLowerCase().trim();
  const gstin = (buyer.gstin || '').toUpperCase().trim();
  if (gstin === '33AAFCK3415K1ZO') return true;
  return name.includes('krishi');
}

/**
 * Resolves the HSN/SAC code to use for a sale/invoice/EWB.
 * Krishi Nutrition Company Pvt Ltd is pinned to constant 11063010.
 * Other buyers use the product's configured HSN (or exempt variant if gstExempt).
 */
export function resolveProductHsn(
  buyer?: { name?: string | null; gstin?: string | null } | null | string,
  taxInfo?: { hsn?: string | null; hsnExempt?: string | null } | null,
  gstExempt?: boolean | null,
  fallback: string = '',
): string {
  if (isKrishiNutritionBuyer(buyer)) {
    return KRISHI_HSN;
  }
  const code = (gstExempt ? taxInfo?.hsnExempt || taxInfo?.hsn : taxInfo?.hsn) || fallback;
  return code;
}


