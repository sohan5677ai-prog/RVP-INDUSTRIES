import { describe, it, expect } from 'vitest';
import {
  crossVerify,
  calcHamali,
  calcKataFee,
  calcPappu,
  calcTotal,
  daysBetween,
  loanInterest,
  pappuLoadingHamali,
  productLoadingHamali,
  transferHamali,
  shellTransferCost,
  transferTransportCharge,
  roundRupee,
  calcSaleFreight,
  landedPricePerKg,
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
  it('default rate 150/tonne with rounded tonnage', () => {
    expect(calcHamali(10400)).toBe(1500); // 10.4 -> 10 tonnes * 150 = 1500
    expect(calcHamali(10550)).toBe(1650); // 10.55 -> 11 tonnes * 150 = 1650
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

  it('productLoadingHamali: flat rate × rounded tonnes', () => {
    expect(productLoadingHamali(16020, 333)).toBe(16 * 333); // husk: 5328
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

  it('shellTransferCost: configurable hamali, per-tonne transport by location', () => {
    const s = shellTransferCost(20000); // default 333/t hamali, PGR COLD transport
    expect(s.hamaliCharge).toBe(20 * 333); // 6660
    expect(s.transportCharge).toBe(20 * 250); // PGR COLD ₹250/t = 5000
    expect(s.totalCost).toBe(6660 + 5000);
    expect(shellTransferCost(20000, 400).hamaliCharge).toBe(20 * 400); // 8000
    // KNM Multi is billed at ₹100/t
    expect(shellTransferCost(20000, 333, 'KNM Multi').transportCharge).toBe(20 * 100); // 2000
  });

  it('transferTransportCharge: rounded tonnes × the location rate', () => {
    expect(transferTransportCharge(20000, 'PGR COLD')).toBe(20 * 250);
    expect(transferTransportCharge(20000, 'Murugan')).toBe(20 * 250);
    expect(transferTransportCharge(20000, 'KNM Multi')).toBe(20 * 100);
    expect(transferTransportCharge(24000, 'KNM Multi')).toBe(24 * 100);
    // unknown / missing location falls back to the default ₹250/t
    expect(transferTransportCharge(10000, 'Somewhere')).toBe(10 * 250);
    expect(transferTransportCharge(10000, null)).toBe(10 * 250);
  });
});

describe('calcKataFee', () => {
  it('tiered weighbridge fee', () => {
    expect(calcKataFee(15000)).toBe(50); // <= 15t
    expect(calcKataFee(20000)).toBe(150); // 15-30t
    expect(calcKataFee(30000)).toBe(150); // 15-30t (upper edge)
    expect(calcKataFee(31000)).toBe(200); // > 30t
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
