/**
 * Weighbridge indicator fault detection.
 *
 * Rules (kept identical in client/src/lib/scaleFault.ts):
 *  - A fault comes ONLY from a complete frame the indicator sent. Connection
 *    errors ("Could not open COM4", "Failed to connect") are an OFFLINE scale,
 *    never a load-cell fault, so nothing here is ever run on an error message.
 *  - Fault words must stand alone, and "?" only counts when it is all the
 *    indicator is showing, so one garbled byte cannot hide a good weight.
 *  - The state flips only after FAULT_DEBOUNCE_FRAMES consecutive frames agree,
 *    so a single noisy frame neither raises nor clears the fault.
 */
const FAULT_WORD =
  /(?:^|[^A-Z0-9])(NO[\s-]?DL[CS]?|DL[CS]|ERR(?:OR)?|OVERLOAD|OPEN|FAIL(?:ED)?)(?![A-Z])/;
const ONLY_QUESTION_MARKS = /^[\s?]+$/;
const DASHES = /-{4,}|^OL$/;

export type ScaleFault = 'NO DLC' | 'NO DLS' | 'OVERLOAD' | 'SCALE ERROR';

export const FAULT_DEBOUNCE_FRAMES = 2;

/** Classify ONE complete indicator frame. Returns null for a normal frame. */
export function detectScaleFault(frame?: string | null): ScaleFault | null {
  const upper = (frame ?? '').toUpperCase().trim();
  if (!upper) return null;
  if (!FAULT_WORD.test(upper) && !ONLY_QUESTION_MARKS.test(upper) && !DASHES.test(upper)) return null;
  if (/DLS/.test(upper) && !/DLC/.test(upper)) return 'NO DLS';
  if (/DLC/.test(upper)) return 'NO DLC';
  if (/OVERLOAD|^OL$|-{4,}/.test(upper)) return 'OVERLOAD';
  return 'SCALE ERROR';
}

/** Short operator-facing explanation for a fault label. */
export function describeScaleFault(fault: ScaleFault): string {
  switch (fault) {
    case 'NO DLC':
    case 'NO DLS':
      return 'Load cell signal lost';
    case 'OVERLOAD':
      return 'Indicator over range';
    default:
      return 'Indicator reported an error';
  }
}

/**
 * Debounces per-frame results into a steady fault state. Feed it every
 * complete frame: the frame's fault, or null for a good weight frame.
 */
export function createFaultTracker(threshold = FAULT_DEBOUNCE_FRAMES) {
  let current: ScaleFault | null = null;
  let candidate: ScaleFault | null | undefined;
  let streak = 0;
  return {
    get fault() {
      return current;
    },
    push(frameFault: ScaleFault | null): ScaleFault | null {
      if (frameFault === current) {
        candidate = undefined;
        streak = 0;
        return current;
      }
      if (frameFault === candidate) streak += 1;
      else {
        candidate = frameFault;
        streak = 1;
      }
      if (streak >= threshold) {
        current = frameFault;
        candidate = undefined;
        streak = 0;
      }
      return current;
    },
    reset() {
      current = null;
      candidate = undefined;
      streak = 0;
    },
  };
}
