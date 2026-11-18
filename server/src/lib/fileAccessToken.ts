import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Expiring capability links for stored files (Phase 5, carried over from
 * [PHASE-6B](../../docs/security/PHASE-6B.md) M2).
 *
 * ---------------------------------------------------------------------------
 * The problem
 *
 * Supplier invoices, kata slips, payment screenshots and weighbridge slips go
 * into a **public** Supabase bucket, and the resulting `getPublicUrl` link is
 * stored in the database and shared over WhatsApp and email. Object names are
 * 16 random bytes, so nobody can enumerate them - but the links **never
 * expire and cannot be revoked**. Anyone ever forwarded one can read that
 * invoice, with its party name, GSTIN and amounts, for ever.
 *
 * Why this cannot simply be solved with authentication: the files are fetched
 * by things that cannot sign in. WhatsApp's media fetcher pulls the URL
 * server-to-server with no headers, and in the browser they are loaded by
 * `<img src>` and `<a href>`, which cannot send an Authorization header.
 *
 * So the authorization has to live **in the URL**, and expire. That is already
 * the established pattern in this codebase: the weighbridge slip is served
 * from our own endpoint with an HMAC token in the query string
 * (`/weighbridge/tickets/:id/slip.jpg?token=...`), precisely so WhatsApp can
 * fetch it. This generalises that, and adds the part the slip link is missing:
 * **an expiry**. The slip token is HMAC over the id and the paid-at time, so
 * it is also a forever-link, just on our domain instead of Supabase's.
 * ---------------------------------------------------------------------------
 *
 * The signature covers the object name *and* the expiry, so neither can be
 * changed without invalidating it - signing the name alone would let anyone
 * extend their own link indefinitely by editing `exp`.
 */

/** How long a minted link is good for, unless a caller asks for otherwise. */
export const DEFAULT_FILE_TTL_SECONDS = 15 * 60;

/**
 * A WhatsApp or email recipient may open the message hours later, so links
 * that go to third parties get a longer life than ones used in the app.
 * Still finite, which is the entire point.
 */
export const SHARED_FILE_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Object names this module will serve: the 32 hex characters that
 * `uploadFileToStorage` generates, and an allow-listed extension.
 *
 * Anchored and strict, because this value arrives from a URL path and is then
 * handed to storage. A loose pattern here is a path traversal.
 */
const OBJECT_NAME = /^[0-9a-f]{32}\.(pdf|jpg|jpeg|png|webp|gif)$/;

export function isValidObjectName(name: string): boolean {
  return OBJECT_NAME.test(name);
}

function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET must be set to mint file access links.');
  return s;
}

function sign(objectName: string, exp: number): string {
  return createHmac('sha256', secret()).update(`file:${objectName}:${exp}`).digest('hex');
}

/**
 * Pull the storage object name out of whatever is stored in the database.
 *
 * Three shapes exist in the wild, and all three have to keep working:
 *  - a bare object name, which is what new uploads will store;
 *  - a Supabase public URL, which is what every existing row holds;
 *  - one of our own `/api/files/...` links, in case one is ever round-tripped.
 *
 * Returns null for anything else - an external URL, a data URI, a stray value
 * - so a caller can leave it alone rather than mangle it.
 */
export function objectNameFromStored(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const value = stored.trim();
  if (value === '') return null;

  if (isValidObjectName(value)) return value;

  // Take the last path segment, minus any query string, and check it.
  const withoutQuery = value.split('?')[0];
  const last = withoutQuery.split('/').filter(Boolean).pop();
  if (last && isValidObjectName(last)) {
    // Only accept it when it really came from a storage or files URL, so an
    // unrelated link that happens to end in 32 hex characters is left alone.
    if (/\/storage\/v1\/object\//.test(withoutQuery) || /\/files\//.test(withoutQuery)) {
      return last;
    }
  }
  return null;
}

/** The API origin these links point at, without a trailing slash. */
function apiBase(): string {
  return (process.env.PUBLIC_API_BASE_URL || 'https://rvp-server.onrender.com/api').replace(
    /\/$/,
    ''
  );
}

export interface MintedFileLink {
  url: string;
  expiresAt: number;
}

/**
 * Mint an expiring link to a stored file.
 *
 * Takes whatever is in the database - object name or legacy public URL - so a
 * caller never has to know which it has.
 */
export function mintFileUrl(
  stored: string | null | undefined,
  ttlSeconds: number = DEFAULT_FILE_TTL_SECONDS,
  now: number = Date.now()
): MintedFileLink | null {
  const objectName = objectNameFromStored(stored);
  if (!objectName) return null;

  const exp = Math.floor(now / 1000) + ttlSeconds;
  const sig = sign(objectName, exp);
  return {
    url: `${apiBase()}/files/${objectName}?exp=${exp}&sig=${sig}`,
    expiresAt: exp * 1000,
  };
}

export type FileTokenResult = 'ok' | 'bad-name' | 'expired' | 'bad-signature' | 'malformed';

/**
 * Check a link's token. Returns *why* it failed, so the endpoint can answer
 * 404 for a nonexistent name and 403 for a bad or stale token, and so a
 * support question - "the link in my email stopped working" - has an answer.
 */
export function verifyFileToken(params: {
  objectName: string;
  exp: unknown;
  sig: unknown;
  now?: number;
}): FileTokenResult {
  const { objectName, exp, sig, now = Date.now() } = params;

  if (!isValidObjectName(objectName)) return 'bad-name';
  if (typeof exp !== 'string' || typeof sig !== 'string') return 'malformed';

  const expNum = Number(exp);
  if (!Number.isInteger(expNum) || expNum <= 0) return 'malformed';
  if (!/^[0-9a-f]{64}$/.test(sig)) return 'malformed';

  // Signature before expiry: checking expiry first would tell an attacker
  // which object names are real before they have presented a valid token.
  const expected = sign(objectName, expNum);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(sig, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return 'bad-signature';

  if (expNum * 1000 <= now) return 'expired';
  return 'ok';
}
