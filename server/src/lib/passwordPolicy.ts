import { COMMON_PASSWORDS } from './commonPasswords.js';

/**
 * Password policy, per plan item 1.2.
 *
 * Length and a blocklist, deliberately not a character-class rule. Forcing an
 * uppercase, a digit and a symbol reliably produces `Password@1` — which is in
 * every breach list — so NIST SP 800-63B dropped composition rules in favour of
 * length plus screening against known-compromised passwords. That is what this
 * implements.
 */

export const MIN_PASSWORD_LENGTH = 12;
/** bcrypt silently truncates at 72 bytes; argon2 does not, but keep a sane cap. */
export const MAX_PASSWORD_LENGTH = 200;
/** How many previous hashes a password may not match (plan item 1.2). */
export const PASSWORD_HISTORY_DEPTH = 5;

export interface PolicyContext {
  username?: string;
  name?: string;
  email?: string | null;
}

/**
 * Normalise for blocklist comparison: case-folded, with the leet substitutions
 * and trailing digits people add to get a weak password past a filter.
 */
function deleet(s: string): string {
  return s
    .replace(/[4@]/g, 'a')
    .replace(/[3]/g, 'e')
    .replace(/[1!|]/g, 'i')
    .replace(/[0]/g, 'o')
    .replace(/[5$]/g, 's')
    .replace(/[7]/g, 't');
}

/** Strip a trailing run of digits and punctuation: "monkey123!" -> "monkey". */
function stripTail(s: string): string {
  return s.replace(/[\d\W_]+$/, '');
}

function normaliseForBlocklist(plain: string): string[] {
  const lower = plain.toLowerCase();
  // Both orders matter, and getting this wrong is easy: de-leeting first turns
  // "password1234" into "passwordi2ea", whose tail is letters and can no longer
  // be stripped - so the blocklist would never see "password". Stripping first
  // handles that, while de-leeting first is what catches "Adm1n1strat0r".
  return [
    ...new Set(
      [
        lower,
        stripTail(lower),
        deleet(lower),
        stripTail(deleet(lower)),
        deleet(stripTail(lower)),
        stripTail(deleet(stripTail(lower))),
      ].filter(Boolean)
    ),
  ];
}

/** A single repeated character, or a straight run up or down the alphabet/keypad. */
function isTriviallySequential(plain: string): boolean {
  const lower = plain.toLowerCase();
  if (/^(.)\1+$/.test(lower)) return true;
  let ascending = true;
  let descending = true;
  for (let i = 1; i < lower.length; i++) {
    const delta = lower.charCodeAt(i) - lower.charCodeAt(i - 1);
    if (delta !== 1) ascending = false;
    if (delta !== -1) descending = false;
  }
  return ascending || descending;
}

/**
 * Check a candidate password. Returns every problem rather than the first, so
 * the user fixes them in one go instead of playing whack-a-mole.
 */
export function validatePassword(plain: string, ctx: PolicyContext = {}): string[] {
  const problems: string[] = [];

  if (plain.length < MIN_PASSWORD_LENGTH) {
    problems.push(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (plain.length > MAX_PASSWORD_LENGTH) {
    problems.push(`Use at most ${MAX_PASSWORD_LENGTH} characters.`);
  }
  if (plain !== plain.trim()) {
    // Leading/trailing spaces are nearly always a paste accident, and the user
    // will not be able to tell why sign-in then fails.
    problems.push('Remove the spaces at the start or end.');
  }

  const variants = normaliseForBlocklist(plain);
  if (variants.some((v) => COMMON_PASSWORDS.has(v))) {
    problems.push('That is one of the most commonly used passwords. Pick something else.');
  }

  if (plain.length >= MIN_PASSWORD_LENGTH && isTriviallySequential(plain)) {
    problems.push('Do not use a single repeated character or a straight sequence.');
  }

  // Anything derived from the account itself is public knowledge. The name is
  // split into words as well as kept whole: a surname on its own is every bit
  // as guessable as the full name, and "KumarKumarKumar" would otherwise pass
  // a check that only looked for "sohan kumar".
  const personal = [ctx.username, ctx.name, ctx.email?.split('@')[0]]
    .filter((v): v is string => !!v)
    .flatMap((v) => [v, ...v.split(/[\s._-]+/)])
    .filter((v) => v.length >= 3)
    .map((v) => v.toLowerCase());
  const lower = plain.toLowerCase();
  if (personal.some((p) => lower.includes(p))) {
    problems.push('Do not include your name, username or email address.');
  }
  if (lower.includes('rvp') || lower.includes('tamarind')) {
    problems.push('Do not use the company or product name.');
  }

  return problems;
}

/** True when the password satisfies the policy. */
export function isPasswordAcceptable(plain: string, ctx: PolicyContext = {}): boolean {
  return validatePassword(plain, ctx).length === 0;
}
