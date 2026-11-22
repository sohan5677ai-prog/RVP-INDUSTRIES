/**
 * Decide whether text coming off the weighbridge indicator is a hardware fault.
 *
 * The old check was a plain substring search for "DLC", "OPEN", "FAIL", "ERR"
 * and a bare "?". A garbled byte on the serial line decodes to "?" and a stray
 * "ERR"/"OPEN" fragment is easy to hit, so the live weight was blanked and the
 * NO DLC banner raised for a perfectly good reading. Fault words now have to be
 * standalone tokens, and "?" only counts when it is all the indicator is
 * showing (no digits at all).
 */
const FAULT_WORD =
  /(?:^|[^A-Z0-9])(NO[\s-]?DL[CS]?|DL[CS]|ERR(?:OR)?|OVERLOAD|OPEN|FAIL(?:ED)?)(?![A-Z])/;
const ONLY_QUESTION_MARKS = /^[\s?]+$/;
const DASHES = /-{4,}|^OL$/;

export type ScaleFault = 'NO DLC' | 'NO DLS';

export function detectScaleFault(text?: string | null): ScaleFault | null {
  const upper = (text ?? '').toUpperCase().trim();
  if (!upper) return null;
  if (!FAULT_WORD.test(upper) && !ONLY_QUESTION_MARKS.test(upper) && !DASHES.test(upper)) return null;
  return /DLS/.test(upper) && !/DLC/.test(upper) ? 'NO DLS' : 'NO DLC';
}
