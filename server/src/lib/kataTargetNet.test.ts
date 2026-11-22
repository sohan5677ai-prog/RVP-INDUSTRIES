import { describe, expect, it } from 'vitest';
import { applyTargetNet, readTargetNet, TargetNetError } from './kataTargetNet.js';

describe('applyTargetNet', () => {
  it('raises the second weight of a lorry loaded at the kata so net equals the target', () => {
    // empty 14,000 in; real load 34,800 -> target 35,010
    const r = applyTargetNet(14_000, 48_800, 35_010);
    expect(r).toEqual({ secondKg: 49_010, netKg: 35_010, actualSecondKg: 48_800, actualNetKg: 34_800, applied: true });
  });

  it('lowers the second weight of a lorry that unloaded', () => {
    const r = applyTargetNet(50_000, 15_100, 35_010);
    expect(r.secondKg).toBe(14_990);
    expect(r.netKg).toBe(35_010);
    expect(r.actualNetKg).toBe(34_900);
  });

  it('leaves the reading alone with no target or when it already matches', () => {
    expect(applyTargetNet(14_000, 48_800, null)).toMatchObject({ secondKg: 48_800, netKg: 34_800, applied: false, actualNetKg: null });
    expect(applyTargetNet(14_000, 49_010, 35_010)).toMatchObject({ secondKg: 49_010, applied: false });
  });

  it('rejects a target that looks like a typo', () => {
    expect(() => applyTargetNet(14_000, 48_800, 3_501)).toThrow(TargetNetError);
  });
});

describe('readTargetNet', () => {
  it('treats blanks and zero as no target', () => {
    expect(readTargetNet('')).toBeNull();
    expect(readTargetNet(null)).toBeNull();
    expect(readTargetNet(0)).toBeNull();
    expect(readTargetNet('35010')).toBe(35_010);
  });
  it('rejects absurd values', () => {
    expect(() => readTargetNet(50)).toThrow(TargetNetError);
    expect(() => readTargetNet(120_000)).toThrow(TargetNetError);
  });
});
