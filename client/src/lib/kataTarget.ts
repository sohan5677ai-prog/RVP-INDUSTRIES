/**
 * Client mirror of server/src/lib/kataTargetNet.ts - lets the cabin show, live,
 * what the ticket will record when a target net is set. The server recomputes
 * from the real reading on save; this is display only.
 */
export const MAX_TARGET_DEVIATION = 0.15;

export interface TargetProjection {
  /** Second weight the ticket will record. */
  recordedSecondKg: number;
  /** Net weight the ticket will record. */
  recordedNetKg: number;
  /** Net weight off the real reading. */
  actualNetKg: number;
  /** target - actual net: positive means load this much more on the platform scale. */
  topUpKg: number;
  applied: boolean;
  tooFar: boolean;
}

export function parseTargetNet(raw: string): number | null {
  const n = Math.round(Number(String(raw).replace(/,/g, '').trim()));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function projectTargetNet(firstKg: number, liveKg: number, targetKg: number | null): TargetProjection {
  const actualNetKg = Math.abs(liveKg - firstKg);
  if (targetKg == null || liveKg <= 0) {
    return { recordedSecondKg: liveKg, recordedNetKg: actualNetKg, actualNetKg, topUpKg: 0, applied: false, tooFar: false };
  }
  const topUpKg = targetKg - actualNetKg;
  const tooFar = Math.abs(topUpKg) / targetKg > MAX_TARGET_DEVIATION;
  const loadedHere = liveKg > firstKg;
  return {
    recordedSecondKg: loadedHere ? firstKg + targetKg : firstKg - targetKg,
    recordedNetKg: targetKg,
    actualNetKg,
    topUpKg,
    applied: !tooFar && topUpKg !== 0,
    tooFar,
  };
}
