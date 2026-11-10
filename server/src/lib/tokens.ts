import jwt from 'jsonwebtoken';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Role } from '@prisma/client';
import { HttpError } from './httpError.js';

/**
 * Access and refresh tokens, per plan item 1.5.
 *
 * Before this, one JWT lived for 7 days and nothing revoked it: a password
 * change or a role demotion left every issued token working until it expired.
 * Cookies were the other option the plan allows, but the Slack bot, the Tally
 * agent, the CCTV bridge, the print agent and the kata cabin all authenticate
 * with headers, so a cookie migration would have meant special-casing five
 * non-browser clients. Instead:
 *
 *   - a short-lived access token, so a leaked one expires on its own;
 *   - a long-lived refresh token, rotated on every use and stored only as a
 *     hash, so the database never holds anything replayable;
 *   - an absolute cap on the session, so keeping it warm does not make it
 *     immortal;
 *   - `pwdAt` in the access token, checked against the user's
 *     passwordChangedAt, which is what makes a password change log out every
 *     other device immediately rather than eventually.
 */

export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
/** Hard cap on a session's life, however active it is (plan item 1.5). */
export const ABSOLUTE_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** A refresh token outlives the access token but not the session. */
export const REFRESH_TOKEN_BYTES = 32;

export interface AccessTokenPayload {
  userId: string;
  role: Role;
  /** UserSession row this token belongs to. */
  sid: string;
  /**
   * The user's passwordChangedAt in epoch ms at issue time. A token whose
   * `pwdAt` is older than the stored value is refused, so changing a password
   * invalidates every token issued before it.
   */
  pwdAt: number;
  /** Narrow token for the permanently installed cabin screen. */
  scope?: 'KATA_CABIN';
  /** Kept in the signed token so kata tickets retain the operator name. */
  name?: string;
  /** Set once MFA has been satisfied for this session. */
  mfa?: boolean;
}

let cachedSecret: string | undefined;

function getSecret(): string {
  if (cachedSecret) return cachedSecret;
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 16) {
    throw new HttpError(
      500,
      'JWT_SECRET is missing or too short. Set a long (32+ char) random string.'
    );
  }
  cachedSecret = s;
  return s;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, getSecret(), { expiresIn: ACCESS_TOKEN_TTL_MS / 1000 });
}

/**
 * Long-lived token for a non-browser principal: the Slack bot and the kata
 * cabin screen.
 *
 * These carry `sid: 'service'` and no UserSession row, so they are exempt from
 * the idle timeout, the device cap and the refresh cycle - a kiosk bolted to a
 * wall cannot be asked to re-authenticate every fifteen minutes, and the Slack
 * bot has no one to prompt. `pwdAt: 0` makes the password-change check a no-op
 * for them, which is correct: they are not authenticated by a password, so a
 * password change has no bearing on them.
 *
 * The tradeoff is deliberate and worth stating plainly: these tokens cannot be
 * revoked except by rotating JWT_SECRET. The cabin's is constrained to the
 * weighbridge routes by the KATA_CABIN scope check, which is what makes that
 * acceptable.
 */
export function signServiceToken(
  payload: Omit<AccessTokenPayload, 'pwdAt'>,
  expiresIn: jwt.SignOptions['expiresIn'] = '30d'
): string {
  return jwt.sign({ ...payload, pwdAt: 0 }, getSecret(), { expiresIn });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, getSecret()) as AccessTokenPayload;
}

/**
 * A refresh token is opaque random bytes, not a JWT. It carries no claims and
 * is only ever matched against a hash, so there is nothing in it to forge.
 */
export function mintRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

/**
 * SHA-256 rather than a password hash: this is a 256-bit random value, so there
 * is no dictionary to attack and nothing for a slow hash to buy. Being fast
 * also matters, since it runs on every refresh.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time comparison of a presented refresh token against a stored hash. */
export function refreshTokenMatches(presented: string, storedHash: string): boolean {
  const a = Buffer.from(hashRefreshToken(presented));
  const b = Buffer.from(storedHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Has the access token been invalidated by a password change?
 *
 * Compared with a second of slack: `passwordChangedAt` has millisecond
 * precision in Postgres while the JWT `iat` does not, and a token minted in
 * the same moment as the change must not be rejected as stale.
 */
export function tokenPredatesPasswordChange(
  payload: AccessTokenPayload,
  passwordChangedAt: Date
): boolean {
  return payload.pwdAt + 1000 < passwordChangedAt.getTime();
}

/** When a session started now must end regardless of activity. */
export function absoluteExpiryFrom(now: Date = new Date()): Date {
  return new Date(now.getTime() + ABSOLUTE_SESSION_TTL_MS);
}
