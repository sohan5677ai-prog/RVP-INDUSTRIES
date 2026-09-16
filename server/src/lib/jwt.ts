import jwt from 'jsonwebtoken';
import { createHmac } from 'crypto';
import type { Role } from '@prisma/client';

export interface JwtPayload {
  userId: string;
  role: Role;
  /** UserSession row this token belongs to — one per signed-in device. */
  sid: string;
  /** A deliberately narrow token issued to the permanently installed cabin screen. */
  scope?: 'KATA_CABIN';
  /** Kept in the signed token so kata tickets retain the dedicated operator name. */
  name?: string;
}

let cachedSecret: string | undefined;

/**
 * Resolve the signing secret, refusing a missing or trivially short one. Called
 * lazily (on first sign/verify) rather than at import so tools/tests that merely
 * import this module don't crash; call assertJwtSecret() at boot to fail fast.
 */
function getSecret(): string {
  if (cachedSecret) return cachedSecret;
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 16) {
    throw new Error(
      'JWT_SECRET is missing or too short. Set a long (32+ char) random string in the environment before starting the server.'
    );
  }
  cachedSecret = s;
  return s;
}

/** Fail-fast check to run once at server startup. */
export function assertJwtSecret(): void {
  getSecret();
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, getSecret(), { expiresIn: '7d' });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, getSecret()) as JwtPayload;
}

/**
 * Stable per-deployment cabin activation credential. It is derived from the
 * JWT secret without exposing that master secret and can be overridden with a
 * separately managed KATA_CABIN_ACCESS_KEY when desired.
 */
export function getKataCabinAccessKey(): string {
  const configured = process.env.KATA_CABIN_ACCESS_KEY;
  if (configured && configured.length >= 24) return configured;
  return createHmac('sha256', getSecret())
    .update('rvp-kata-cabin-activation-v1')
    .digest('base64url');
}
