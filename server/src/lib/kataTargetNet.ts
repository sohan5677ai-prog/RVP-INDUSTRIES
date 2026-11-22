/**
 * Target net weight for a kata ticket (used for Pappu loads).
 *
 * A buyer orders an exact figure such as 35,010 kg. Loading a lorry to that
 * exact figure on the weighbridge takes several back-and-forth weighings, so the
 * operator enters the target on the first weight instead. On the second weight
 * the actual reading is kept (actualSecondWeightKg / actualNetWeightKg) and the
 * cabin shows it; the shortfall is then made up on the platform scale, and the
 * ticket records the second weight that gives exactly the target net.
 *
 * The real reading is never thrown away - it stays on the ticket for audit.
 */

/** A target further than this from the real net is treated as a typo. */
export const MAX_TARGET_DEVIATION = 0.15;

export interface TargetNetResult {
  /** Second weight the ticket records. */
  secondKg: number;
  /** Net weight the ticket records. */
  netKg: number;
  /** Real scale reading and real net, only when the target was applied. */
  actualSecondKg: number | null;
  actualNetKg: number | null;
  applied: boolean;
}

/** Parses a target from the request body. Empty / 0 means "no target". */
export function readTargetNet(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 100 || n > 80_000) {
    throw new TargetNetError(`Target net weight of ${n.toLocaleString('en-IN')} kg is not a realistic lorry load`);
  }
  return n;
}

export class TargetNetError extends Error {}

/**
 * The second weight that makes the net equal the target. Direction follows the
 * real reading: a lorry that came back heavier was loaded at the kata (pappu
 * sale), one that came back lighter was unloaded.
 */
export function applyTargetNet(firstKg: number, actualSecondKg: number, targetNetKg: number | null): TargetNetResult {
  const actualNet = Math.abs(actualSecondKg - firstKg);
  if (targetNetKg == null || targetNetKg === actualNet) {
    return { secondKg: actualSecondKg, netKg: actualNet, actualSecondKg: null, actualNetKg: null, applied: false };
  }

  const deviation = Math.abs(targetNetKg - actualNet) / Math.max(targetNetKg, 1);
  if (deviation > MAX_TARGET_DEVIATION) {
    throw new TargetNetError(
      `Target net ${targetNetKg.toLocaleString('en-IN')} kg is too far from the real net ${actualNet.toLocaleString('en-IN')} kg ` +
        `(more than ${Math.round(MAX_TARGET_DEVIATION * 100)}%). Check the target, or clear it.`,
    );
  }

  const loadedHere = actualSecondKg > firstKg;
  const secondKg = loadedHere ? firstKg + targetNetKg : firstKg - targetNetKg;
  if (secondKg <= 0) {
    throw new TargetNetError('Target net is larger than the first weight - check the target');
  }
  return { secondKg, netKg: targetNetKg, actualSecondKg, actualNetKg: actualNet, applied: true };
}
