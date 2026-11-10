import { createHmac } from 'crypto';

let cachedSecret: string | undefined;

/**
 * Resolve the signing secret, refusing a missing or trivially short one.
 *
 * Token signing and verification moved to lib/tokens.ts in Phase 1; what is
 * left here is the secret itself and the cabin activation key derived from it.
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
