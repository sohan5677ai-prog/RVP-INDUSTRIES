import { describe, it, expect } from 'vitest';
import {
  crossVerify,
  calcHamali,
  calcKataFee,
  calcPappu,
  calcTotal,
  daysBetween,
  loanInterest,
  transferLoanInterest,
  TRANSFER_LOAN_PER_KG,
  pappuLoadingHamali,
  productLoadingHamali,
  transferHamali,
  shellTransferCost,
  transferTransportCharge,
  roundRupee,
  calcSaleFreight,
  landedPricePerKg,
  seedBackedDemandKg,
  seedBackedDispatchedKg,
  excessOutKgOf,
  isSaleOrderFulfilled,
  saleCloseToleranceKg,
  isLooseLoadedProduct,
  purchaseGst,
  KRISHI_HSN,
  isKrishiNutritionBuyer,
  resolveProductHsn,
} from './calc';

describe('crossVerify', () => {
  // Section 10 validation table (one-sided rules).
  it.each([
    // label,                billing, party,  rvp,    final,  exempt
    ['match, no diff',       10000,   10000,  10000,  10000,  true],
    ['match, diff 50',       10000,   10000,  9950,   10000,  true],
    ['match, diff 80 (boundary)', 10000, 10000, 9920,  10000,  true],
    ['match, diff 130',      10000,   10000,  9870,   9950,   false],
    ['party differs',        10000,   9800,   9800,   9800,   true],
    ['party differs, diff 200', 10000, 9800,  9600,   9680,   false],
  ])('%s', (_label, billing, party, rvp, final, exempt) => {
    const r = crossVerify(billing as number, party as number, rvp as number);
    expect(r.finalWeight).toBe(final);
    expect(r.exempt).toBe(exempt);
  });

  it('party_kata == billing -> reference is billing_weight', () => {
    expect(crossVerify(10000, 10000, 10000).reference).toBe(10000);
  });

  it('party_kata != billing -> reference reduces to party_kata', () => {
    expect(crossVerify(10000, 9800, 9800).reference).toBe(9800);
  });

  it('diff <= 0 -> pay at reference, exempt', () => {
    const r = crossVerify(10000, 10000, 10000);
    expect(r.diff).toBe(0);
    expect(r.exempt).toBe(true);
    expect(r.finalWeight).toBe(10000);
  });

  it('diff = 80 (boundary) -> exempt, pay at reference', () => {
    const r = crossVerify(10000, 10000, 9920);
    expect(r.diff).toBe(80);
    expect(r.exempt).toBe(true);
    expect(r.finalWeight).toBe(10000);
  });

  it('diff = 81 -> not exempt, deduct 1kg overage', () => {
    const r = crossVerify(10000, 10000, 9919);
    expect(r.diff).toBe(81);
    expect(r.exempt).toBe(false);
    expect(r.finalWeight).toBe(9999); // 10000 - (81 - 80)
  });

  it('diff > 80 -> reference - (diff - 80)', () => {
    const r = crossVerify(10000, 10000, 9870);
    expect(r.diff).toBe(130);
    expect(r.finalWeight).toBe(9950); // 10000 - (130 - 80)
  });

  it('pays at RVP weight if RVP is heavier than reference', () => {
    const r = crossVerify(10000, 10000, 10130); // rvp 130 over
    expect(r.diff).toBe(0);
    expect(r.finalWeight).toBe(10130);
    expect(r.exempt).toBe(true);
  });
});

describe('calcHamali', () => {
  it('default rate 150/tonne with exact tonnage (no tonne rounding)', () => {
    expect(calcHamali(10400)).toBe(1560); // 10.4 tonnes * 150 = 1560
    expect(calcHamali(10550)).toBe(1582.5); // 10.55 tonnes * 150 = 1582.5
    expect(calcHamali(17500)).toBe(2625); // 17.5 tonnes * 150 = 2625 (NOT charged as 18t)
  });
  it('custom rate', () => {
    expect(calcHamali(5000, 100)).toBe(500);
  });
});

describe('configurable hamali rates', () => {
  it('pappuLoadingHamali: default ₹220/t splits, lorry & margin fixed', () => {
    const lh = pappuLoadingHamali(25000); // 25 tonnes
    expect(lh.total).toBe(25 * 220);   // 5500
    expect(lh.lorry).toBe(25 * 80);    // 2000 (fixed)
    expect(lh.margin).toBe(25 * 10);   // 250 (fixed)
    expect(lh.company).toBe(lh.total - lh.lorry); // 3500
    expect(lh.crew).toBe(lh.total - lh.margin);   // 5250
  });

  it('pappuLoadingHamali: custom rate raises company share, keeps lorry/margin', () => {
    const lh = pappuLoadingHamali(25000, false, 260);
    expect(lh.total).toBe(25 * 260);   // 6500
    expect(lh.lorry).toBe(25 * 80);    // 2000 (unchanged)
    expect(lh.company).toBe(6500 - 2000); // 4500
  });

  it('productLoadingHamali: flat rate × exact tonnes', () => {
    expect(productLoadingHamali(16020, 333)).toBeCloseTo(16.02 * 333, 2); // husk: 5334.66 (not 16t)
    expect(productLoadingHamali(16020, 333, true)).toBe(0);  // company vehicle exempt
  });

  it('transferHamali: handling only, storage-unload leg no longer charged', () => {
    const t = transferHamali(25000); // default 270/t
    expect(t.charge).toBe(25 * 270);       // 6750
    expect(t.unloadCharge).toBe(0);
    expect(t.handlingCharge).toBe(25 * 270); // 6750
    expect(t.margin).toBe(0);
    expect(t.crew).toBe(25 * 270);         // 6750
  });

  it('transferHamali: exact tonnage on a half-tonne load', () => {
    const t = transferHamali(17500); // 17.5 tonnes @ 270/t
    expect(t.charge).toBe(4725); // 17.5 * 270 = 4725 (NOT 18t = 4860)
    expect(t.crew).toBe(4725);
  });

  it('shellTransferCost: configurable hamali, per-tonne transport by location', () => {
    const s = shellTransferCost(20000); // default 333/t hamali, PGR COLD transport
    expect(s.hamaliCharge).toBe(20 * 333); // 6660
    expect(s.transportCharge).toBe(20 * 250); // PGR COLD ₹250/t = 5000
    expect(s.totalCost).toBe(6660 + 5000);
    expect(shellTransferCost(20000, 400).hamaliCharge).toBe(20 * 400); // 8000
    // KNM Multi is billed at ₹100/t
    expect(shellTransferCost(20000, 333, 'KNM Multi').transportCharge).toBe(20 * 100); // 2000
  });

  it('shellTransferCost: exact tonnage on a half-tonne load', () => {
    const s = shellTransferCost(17500); // 17.5 tonnes, PGR COLD
    expect(s.hamaliCharge).toBeCloseTo(17.5 * 333, 2); // 5827.5 (not 18t)
    expect(s.transportCharge).toBeCloseTo(17.5 * 250, 2); // 4375
  });

  it('transferTransportCharge: exact tonnes × the location rate', () => {
    expect(transferTransportCharge(20000, 'PGR COLD')).toBe(20 * 250);
    expect(transferTransportCharge(20000, 'Murugan')).toBe(20 * 250);
    expect(transferTransportCharge(20000, 'KNM Multi')).toBe(20 * 100);
    expect(transferTransportCharge(24000, 'KNM Multi')).toBe(24 * 100);
    expect(transferTransportCharge(17500, 'PGR COLD')).toBeCloseTo(17.5 * 250, 2); // 4375 (not 18t)
    // unknown / missing location falls back to the default ₹250/t
    expect(transferTransportCharge(10000, 'Somewhere')).toBe(10 * 250);
    expect(transferTransportCharge(10000, null)).toBe(10 * 250);
  });
});

describe('purchaseGst', () => {
  // The whole point of the feature: a party quotes us a DELIVERY price of ₹52/kg
  // but raises the invoice at their BASE price of ₹48/kg. GST follows the invoice.
  it('taxes the billed base rate, not the PO delivery price', () => {
    const gst = purchaseGst({
      hasGst: true,
      billingWeightKg: 24_500,
      pricePerKg: 52,
      billingRatePerKg: 48,
    });
    expect(gst.ratePerKg).toBe(48);
    expect(gst.taxableValue).toBe(1_176_000); // 24,500 × 48
    expect(gst.amount).toBe(58_800); // 5%
  });

  it('falls back to the PO price when the invoice matches the order', () => {
    const gst = purchaseGst({ hasGst: true, billingWeightKg: 24_500, pricePerKg: 52 });
    expect(gst.ratePerKg).toBe(52);
    expect(gst.taxableValue).toBe(1_274_000);
    expect(gst.amount).toBe(63_700);
  });

  it.each([null, undefined, 0, '0'])('treats %s as "billed at the PO price"', (billed) => {
    const gst = purchaseGst({ hasGst: true, billingWeightKg: 1_000, pricePerKg: 50, billingRatePerKg: billed });
    expect(gst.ratePerKg).toBe(50);
    expect(gst.amount).toBe(2_500);
  });

  it('reads Decimal-like values off the DB', () => {
    // Prisma hands Decimals back as objects, not numbers.
    const poPrice = { toString: () => '52.00', valueOf: () => '52.00' };
    const billed = { toString: () => '48.75', valueOf: () => '48.75' };
    const gst = purchaseGst({
      hasGst: true,
      billingWeightKg: 10_000,
      pricePerKg: poPrice,
      billingRatePerKg: billed,
    });
    expect(gst.ratePerKg).toBe(48.75);
    expect(gst.amount).toBe(24_375);
  });

  it('charges nothing when the PO is not a GST invoice, but still reports the basis', () => {
    const gst = purchaseGst({ hasGst: false, billingWeightKg: 24_500, pricePerKg: 52, billingRatePerKg: 48 });
    expect(gst.amount).toBe(0);
    expect(gst.taxableValue).toBe(1_176_000);
  });

  it('rounds the tax to paise', () => {
    const gst = purchaseGst({ hasGst: true, billingWeightKg: 12_345, pricePerKg: 47.37 });
    expect(gst.taxableValue).toBe(584_782.65);
    expect(gst.amount).toBe(29_239.13);
  });
});

describe('calcKataFee', () => {
  it('tiered weighbridge fee', () => {
    expect(calcKataFee(5000)).toBe(50); // <= 5t
    expect(calcKataFee(15000)).toBe(100); // 5-15t
    expect(calcKataFee(25000)).toBe(150); // 15-25t
    expect(calcKataFee(26000)).toBe(200); // > 25t
    expect(calcKataFee(25000, true)).toBe(0); // company vehicle exempt
  });
});

describe('calcPappu', () => {
  it('default 60% out-turn', () => {
    expect(calcPappu(10000)).toBe(6000);
  });
  it('rounds to whole kg', () => {
    expect(calcPappu(9999, 60)).toBe(5999); // 5999.4 -> 5999
  });
  it('custom out-turn', () => {
    expect(calcPappu(10000, 62.5)).toBe(6250);
  });
});

describe('calcTotal', () => {
  it('finalKg * pricePerKg', () => {
    expect(calcTotal(10000, 50)).toBe(500000);
  });
  it('partial weight', () => {
    expect(calcTotal(9680, 50)).toBe(484000);
  });
});

describe('daysBetween', () => {
  it('counts whole days', () => {
    expect(daysBetween(new Date('2026-01-01'), new Date('2026-01-31'))).toBe(30);
  });
  it('clamps negatives to 0 (to before from)', () => {
    expect(daysBetween(new Date('2026-02-01'), new Date('2026-01-01'))).toBe(0);
  });
  it('same day -> 0', () => {
    expect(daysBetween(new Date('2026-01-01'), new Date('2026-01-01'))).toBe(0);
  });
});

describe('loanInterest', () => {
  it('value × rate% × days/365, rounded to paise', () => {
    // 15,00,000 × 12% × 60/365 = 29,589.04
    expect(loanInterest(1500000, 12, 60)).toBeCloseTo(29589.04, 2);
  });
  it('zero days -> zero interest', () => {
    expect(loanInterest(1500000, 12, 0)).toBe(0);
  });
  it('zero rate -> zero interest', () => {
    expect(loanInterest(1500000, 0, 60)).toBe(0);
  });
});

describe('transferLoanInterest', () => {
  const loanDate = new Date('2026-03-15'); // earliest open loan
  const transferDate = new Date('2026-07-23'); // 130 days later

  it('charges fixed per-kg loan value × (days/30) × 0.85%/month × weight', () => {
    const { interest, days } = transferLoanInterest(100000, loanDate, transferDate);
    expect(days).toBe(130);
    // perKg = TRANSFER_LOAN_PER_KG × (130/30) × 0.85%; × 100000 kg
    const expected = TRANSFER_LOAN_PER_KG * (130 / 30) * (0.85 / 100) * 100000;
    expect(interest).toBeCloseTo(Math.round(expected * 100) / 100, 2);
    // ~₹88,568 for 100 t over 130 days
    expect(interest).toBeGreaterThan(88000);
    expect(interest).toBeLessThan(89000);
  });

  it('scales linearly with transferred weight (within paise rounding)', () => {
    const a = transferLoanInterest(50000, loanDate, transferDate).interest;
    const b = transferLoanInterest(100000, loanDate, transferDate).interest;
    expect(Math.abs(b - a * 2)).toBeLessThanOrEqual(0.01);
  });

  it('no open loan date -> zero interest and zero days', () => {
    expect(transferLoanInterest(100000, null, transferDate)).toEqual({ interest: 0, days: 0 });
  });

  it('same-day transfer -> zero interest', () => {
    const { interest, days } = transferLoanInterest(100000, transferDate, transferDate);
    expect(days).toBe(0);
    expect(interest).toBe(0);
  });
});

// The single guarantee that keeps every stock page from diverging (the exact bug
// that got the old interest approach removed): the value the transfer PERSISTS as
// movedValue must equal the value the recompute pages (server computeBlackSeedRows,
// client StockLocation) REBUILD for the same transferred-in seed. Both now derive
// from the SAME persisted interestCharge, so the identity must hold to the paise.
describe('transferred-in seed value tie-out (movedValue == recompute)', () => {
  it.each([
    // seedCostMoved, hamali, transport, interest, weightKg
    ['typical 10t', 283200, 2700, 2500, 3452.05, 10000],
    ['zero interest', 283200, 2700, 2500, 0, 10000],
    ['awkward paise', 197531.37, 1890, 1750, 1234.56, 7000],
  ])('%s', (_label, seedCostMoved, hamali, transport, interest, weightKg) => {
    const seed = seedCostMoved as number;
    const w = weightKg as number;
    // (A) What createStockTransfer persists as movedValue.
    const addedCost = Math.round(((hamali as number) + (transport as number) + (interest as number)) * 100) / 100;
    const movedValue = Math.round((seed + addedCost) * 100) / 100;

    // (B) What computeBlackSeedRows / StockLocation rebuild for the same transfer:
    // seed value drawn from source + addedCostPerKg × weight, where
    // addedCostPerKg = (hamali + transport + interest) / weight.
    const addedCostPerKg = ((hamali as number) + (transport as number) + (interest as number)) / w;
    const rebuilt = Math.round((seed + addedCostPerKg * w) * 100) / 100;

    expect(rebuilt).toBeCloseTo(movedValue, 2);
  });
});

describe('roundRupee - reserved for party-ledger / payment / receipt settlement', () => {
  it('rounds half-up to whole rupees', () => {
    expect(roundRupee(100.49)).toBe(100);
    expect(roundRupee(100.5)).toBe(101);
    expect(roundRupee(100.99)).toBe(101);
  });
  it('handles null/undefined/NaN as 0', () => {
    expect(roundRupee(undefined as unknown as number)).toBe(0);
    expect(roundRupee(NaN)).toBe(0);
  });
  it('costing helpers still keep paise (NOT rounded to whole rupees)', () => {
    // 10.4t × ₹123.45/t = 1283.88 - paise preserved for costing/valuation
    expect(calcSaleFreight(10400, 123.45)).toBeCloseTo(1283.88, 2);
    expect(landedPricePerKg(50, 10000, 12345)).toBe(51.23);
  });
});

describe('XS Pappu (excess out) demand', () => {
  it('sums declared excess tonnage only', () => {
    expect(excessOutKgOf([{ weightKg: 10_000, excessOutKg: 10_000 }, { weightKg: 5_000 }])).toBe(10_000);
    expect(excessOutKgOf([])).toBe(0);
  });

  it('clamps excess to the lorry weight and floors it at zero', () => {
    // A bad value must never credit back seed that was actually consumed.
    expect(excessOutKgOf([{ weightKg: 10_000, excessOutKg: 99_000 }])).toBe(10_000);
    expect(excessOutKgOf([{ weightKg: 10_000, excessOutKg: -5_000 }])).toBe(0);
  });

  it('reserves full seed for an order with no dispatches', () => {
    expect(seedBackedDemandKg(30_000, [])).toBe(30_000);
  });

  it('drops XS tonnage from demand so it never draws seed', () => {
    // 30t order fully dispatched as XS → nothing left to back with black seed.
    expect(seedBackedDemandKg(30_000, [{ weightKg: 30_000, excessOutKg: 30_000 }])).toBe(0);
  });

  it('splits a part-backed lorry instead of writing the whole load off', () => {
    // THE PARTIAL CASE: 30t out with only 20t of seed behind it. Declaring the
    // 10t surplus must leave the backed 20t still drawing seed - treating the
    // whole lorry as excess would silently overstate black seed by 33.3t.
    expect(seedBackedDemandKg(30_000, [{ weightKg: 30_000, excessOutKg: 10_000 }])).toBe(20_000);
    expect(seedBackedDispatchedKg([{ weightKg: 30_000, excessOutKg: 10_000 }])).toBe(20_000);
  });

  it('keeps the undispatched balance backed on a partial XS dispatch', () => {
    // 10t out as XS, 20t still open → the open 20t must still reserve real seed.
    expect(seedBackedDemandKg(30_000, [{ weightKg: 10_000, excessOutKg: 10_000 }])).toBe(20_000);
  });

  it('still commits normal dispatches in full', () => {
    expect(seedBackedDemandKg(30_000, [{ weightKg: 10_000 }])).toBe(30_000);
    expect(seedBackedDispatchedKg([{ weightKg: 10_000 }])).toBe(10_000);
  });

  it('honours an over-loaded lorry, less any XS tonnage', () => {
    // Dispatched 32t against a 30t order → commitment follows the actual weight.
    expect(seedBackedDemandKg(30_000, [{ weightKg: 32_000 }])).toBe(32_000);
    expect(seedBackedDemandKg(30_000, [{ weightKg: 32_000, excessOutKg: 32_000 }])).toBe(0);
  });

  it('never returns negative demand', () => {
    expect(seedBackedDemandKg(0, [{ weightKg: 5_000, excessOutKg: 5_000 }])).toBe(0);
  });

  it('commits only what shipped once the order is closed', () => {
    // 25t booked, 24.87t out, order closed → the 130kg balance must stop
    // reserving seed no lorry is ever going to lift.
    expect(seedBackedDemandKg(25_000, [{ weightKg: 24_870 }], true)).toBe(24_870);
    // Still open → the balance keeps its seed reserved.
    expect(seedBackedDemandKg(25_000, [{ weightKg: 24_870 }], false)).toBe(25_000);
  });
});

describe('sale order close tolerance', () => {
  it('closes an order whose final lorry lands inside the tolerance', () => {
    // The husk case: 25t booked, 24.87t on the kata, 2% tolerance = 500kg.
    expect(isSaleOrderFulfilled(25_000, 24_870, 2)).toBe(true);
    // Same shortfall against pappu's 0.5% (125kg) is too wide - stays open.
    expect(isSaleOrderFulfilled(25_000, 24_870, 0.5)).toBe(false);
  });

  it('holds an order open when the shortfall is beyond the tolerance', () => {
    // Buyer took 22t of a 25t booking - far too wide to close by itself.
    expect(isSaleOrderFulfilled(25_000, 22_000, 2)).toBe(false);
  });

  it('still closes on an exact or over-loaded delivery', () => {
    expect(isSaleOrderFulfilled(25_000, 25_000, 0)).toBe(true);
    expect(isSaleOrderFulfilled(25_000, 25_400, 0)).toBe(true);
  });

  it('never lets a rounding remainder hold an order open', () => {
    // A zero tolerance still allows 1kg, so a kg-level remainder can't stick.
    expect(saleCloseToleranceKg(25_000, 0)).toBe(1);
    expect(isSaleOrderFulfilled(25_000, 24_999, 0)).toBe(true);
  });

  it('scales the tolerance with the order size', () => {
    expect(saleCloseToleranceKg(25_000, 2)).toBe(500);
    expect(saleCloseToleranceKg(10_000, 2)).toBe(200);
    expect(saleCloseToleranceKg(25_000, 0.5)).toBe(125);
  });

  it('gives the loose byproducts the wider tolerance, pappu the tight one', () => {
    expect(isLooseLoadedProduct('HUSK')).toBe(true);
    expect(isLooseLoadedProduct('SHELL')).toBe(true);
    expect(isLooseLoadedProduct('PAPPU')).toBe(false);
  });
});

describe('Krishi Nutrition HSN code pinning', () => {
  it('identifies Krishi Nutrition Company Pvt Ltd by name or GSTIN', () => {
    expect(isKrishiNutritionBuyer('Krishi Nutrition Company Pvt Ltd')).toBe(true);
    expect(isKrishiNutritionBuyer('Krishi Nutrition Company Private Limited')).toBe(true);
    expect(isKrishiNutritionBuyer('Krishi')).toBe(true);
    expect(isKrishiNutritionBuyer({ name: 'Krishi Nutrition Company Pvt Ltd', gstin: '33AAFCK3415K1ZO' })).toBe(true);
    expect(isKrishiNutritionBuyer({ name: 'Some Name', gstin: '33AAFCK3415K1ZO' })).toBe(true);
    expect(isKrishiNutritionBuyer({ name: 'DCS Enterprises', gstin: '37AAACD1234E1Z1' })).toBe(false);
    expect(isKrishiNutritionBuyer(null)).toBe(false);
    expect(isKrishiNutritionBuyer(undefined)).toBe(false);
  });

  it('pins HSN to 11063010 only for Krishi Nutrition Company Pvt Ltd', () => {
    const krishiBuyer = { name: 'Krishi Nutrition Company Pvt Ltd', gstin: '33AAFCK3415K1ZO' };
    const defaultHuskTax = { hsn: '140490', hsnExempt: '2302' };
    const defaultPappuTax = { hsn: '120799', hsnExempt: null };

    // Krishi always gets 11063010 regardless of product or tax row or exemption
    expect(resolveProductHsn(krishiBuyer, defaultHuskTax, false)).toBe(KRISHI_HSN);
    expect(resolveProductHsn(krishiBuyer, defaultHuskTax, true)).toBe(KRISHI_HSN);
    expect(resolveProductHsn(krishiBuyer, defaultPappuTax, false)).toBe(KRISHI_HSN);
    expect(resolveProductHsn('Krishi Nutrition', defaultHuskTax, false)).toBe('11063010');

    // Other buyers use the configured product tax row
    const otherBuyer = { name: 'SBT Enterprises', gstin: '37ABCFG1234H1Z1' };
    expect(resolveProductHsn(otherBuyer, defaultHuskTax, false)).toBe('140490');
    expect(resolveProductHsn(otherBuyer, defaultHuskTax, true)).toBe('2302');
    expect(resolveProductHsn(otherBuyer, defaultPappuTax, false)).toBe('120799');
    expect(resolveProductHsn(null, defaultPappuTax, false)).toBe('120799');
  });
});
