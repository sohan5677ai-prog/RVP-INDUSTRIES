/**
 * Whole-word fault detection for the weighbridge indicator's text.
 *
 * A bare substring search for "DLC", "OPEN", "ERR" or "?" raised a load-cell
 * fault on any garbled byte, hiding a good weight. Fault words must now stand
 * alone, and "?" only counts when it is all the indicator is showing.
 */
const FAULT_WORD =
  /(?:^|[^A-Z0-9])(NO[\s-]?DL[CS]?|DL[CS]|ERR(?:OR)?|OVERLOAD|OPEN|FAIL(?:ED)?)(?![A-Z])/;
const ONLY_QUESTION_MARKS = /^[\s?]+$/;
const DASHES = /-{4,}|^OL$/;

export function detectScaleFault(text?: string | null): 'NO DLC' | 'NO DLS' | null {
  const upper = (text ?? '').toUpperCase().trim();
  if (!upper) return null;
  if (!FAULT_WORD.test(upper) && !ONLY_QUESTION_MARKS.test(upper) && !DASHES.test(upper)) return null;
  return /DLS/.test(upper) && !/DLC/.test(upper) ? 'NO DLS' : 'NO DLC';
}
