import { Secret, TOTP } from 'otpauth';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Role } from '@prisma/client';

/**
 * TOTP multi-factor authentication, per plan item 1.3.
 *
 * The plan asks for an authenticator app with email or SMS OTP as a fallback.
 * The fallback here is recovery codes rather than emailed OTPs: an emailed code
 * makes the user's mailbox a second factor that is often open in the same
 * browser, and the mail path depends on Resend being up at the moment someone
 * is locked out. Printed recovery codes have neither problem.
 */

const ISSUER = 'RVP Industries ERP';

/** Allow one step either side, for clock drift between phone and server. */
const WINDOW = 1;
const PERIOD_SECONDS = 30;
const DIGITS = 6;

/**
 * Which roles must have MFA.
 *
 * Plan item 1.3 names admin, finance, accounts and treasury; those roles do not
 * exist here. ADMIN, OWNER and DEVELOPER are the privileged ones, so they are
 * the ones enforced. Phase 2 replaces this with a permission check, at which
 * point it becomes "anyone holding a bank or user-management permission".
 *
 * USER is excluded deliberately: that is the shop-floor and cabin staff, who
 * share devices and do not all have smartphones. Forcing TOTP on them would be
 * answered by one phone kept in a drawer, which is worse than no MFA because it
 * looks like control.
 */
const MFA_REQUIRED_ROLES: ReadonlySet<Role> = new Set(['ADMIN', 'OWNER', 'DEVELOPER'] as Role[]);

export function mfaRequiredFor(role: Role): boolean {
  return MFA_REQUIRED_ROLES.has(role);
}

/** A fresh base32 TOTP secret. */
export function generateMfaSecret(): string {
  return new Secret({ size: 20 }).base32;
}

function totpFor(secret: string, label: string): TOTP {
  return new TOTP({
    issuer: ISSUER,
    label,
    algorithm: 'SHA1',
    digits: DIGITS,
    period: PERIOD_SECONDS,
    secret: Secret.fromBase32(secret),
  });
}

/**
 * The `otpauth://` URI an authenticator app scans. SHA1 is specified because
 * that is what Google Authenticator and most others actually implement, whatever
 * the URI says.
 */
export function mfaEnrolmentUri(secret: string, username: string): string {
  return totpFor(secret, username).toString();
}

/**
 * Verify a submitted code.
 *
 * Returns the matched time step so the caller can refuse a replay of the same
 * code within its window — otherwise a code shoulder-surfed or read off a
 * screen stays usable for up to 90 seconds.
 */
export function verifyTotp(
  secret: string,
  code: string,
  at: Date = new Date()
): { ok: boolean; step?: number } {
  const cleaned = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleaned)) return { ok: false };
  const delta = totpFor(secret, 'verify').validate({
    token: cleaned,
    window: WINDOW,
    timestamp: at.getTime(),
  });
  if (delta === null) return { ok: false };
  return { ok: true, step: Math.floor(at.getTime() / 1000 / PERIOD_SECONDS) + delta };
}

/* ---------------------------------------------------------------- recovery */

/** How many codes are issued at enrolment. */
export const RECOVERY_CODE_COUNT = 10;

/**
 * Human-transcribable alphabet: no 0/O, 1/I/L, 2/Z, 5/S, 8/B, so a code read
 * off paper under mill lighting cannot be mistyped into a different valid code.
 */
const RECOVERY_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679';

function recoveryGroup(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
  }
  return out;
}

/** One code, formatted in two groups for readability: `ABCDE-FGHJK`. */
export function generateRecoveryCode(): string {
  return `${recoveryGroup(5)}-${recoveryGroup(5)}`;
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, generateRecoveryCode);
}

/** Strip formatting so `abcde fghjk` matches `ABCDE-FGHJK`. */
export function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * SHA-256, not a password hash: a recovery code is 50 bits of uniform
 * randomness from a 25-character alphabet, so there is no dictionary to attack
 * and nothing a slow hash would buy. Hashed at all so that a database dump does
 * not hand over a working second factor for every enrolled account.
 */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normaliseRecoveryCode(code)).digest('hex');
}

export function recoveryCodeMatches(presented: string, storedHash: string): boolean {
  const a = Buffer.from(hashRecoveryCode(presented));
  const b = Buffer.from(storedHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* -------------------------------------------------- password reset tokens */

/** Plan item 1.8: single-use, time-limited. */
export const PASSWORD_RESET_TTL_MS = 15 * 60 * 1000;

export function mintPasswordResetToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashPasswordResetToken(token) };
}

export function hashPasswordResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
