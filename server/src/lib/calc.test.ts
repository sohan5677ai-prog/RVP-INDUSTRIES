import { describe, it, expect } from 'vitest';
import { crossVerify, calcHamali, calcPappu, calcTotal } from './calc';

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

  it('does not deduct if RVP is heavier than reference', () => {
    const r = crossVerify(10000, 10000, 10130); // rvp 130 over
    expect(r.diff).toBe(0);
    expect(r.finalWeight).toBe(10000);
    expect(r.exempt).toBe(true);
  });
});

describe('calcHamali', () => {
  it('default rate 80/tonne with rounded tonnage', () => {
    expect(calcHamali(10400)).toBe(800); // 10.4 -> 10 tonnes * 80 = 800
    expect(calcHamali(10550)).toBe(880); // 10.55 -> 11 tonnes * 80 = 880
  });
  it('custom rate', () => {
    expect(calcHamali(5000, 100)).toBe(500);
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
