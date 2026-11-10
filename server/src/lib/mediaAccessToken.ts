import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError } from './httpError.js';

/**
 * Capability token for the weighbridge media endpoints — the live camera
 * frames, the stored snapshots and the scale SSE stream.
 *
 * Why these need something other than the Authorization header: they are
 * consumed by `<img src>` and `EventSource`, neither of which can send
 * headers. That is the reason the routes were left anonymous in the first
 * place, which meant anyone who knew the API host could watch the premises
 * and read live scale weights.
 *
 * The token is a rolling HMAC over a time window rather than a per-user
 * credential, because it ends up in a URL: in the browser's history, in
 * referrers and in any proxy log on the way. So it is deliberately
 *
 *   - short-lived (one window, re-minted on demand by an authenticated call),
 *   - scoped to reading media and nothing else,
 *   - not tied to a user, so leaking one reveals nothing about who held it,
 *   - never accepted for a write (see middleware/mediaAuth.ts).
 *
 * Accepting the previous window as well as the current one keeps a screen that
 * has been open across a boundary working without a refresh, so effective
 * validity is between one and two windows.
 */
const WINDOW_MS = 6 * 60 * 60 * 1000;

const PURPOSE = 'rvp-media-access-v1';

function windowIndex(at: number): number {
  return Math.floor(at / WINDOW_MS);
}

function tokenForWindow(index: number): string {
  // Shares the JWT secret rather than adding another one to manage. Rotating
  // JWT_SECRET invalidates these too, which is the behaviour you want.
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 16) {
    throw new HttpError(500, 'JWT_SECRET is not configured on the server');
  }
  return createHmac('sha256', secret).update(`${PURPOSE}:${index}`).digest('hex');
}

export interface MintedMediaToken {
  token: string;
  /** Epoch ms after which a token minted now stops being accepted. */
  expiresAt: number;
}

/** Mint the token for the window containing `at`. */
export function mintMediaAccessToken(at: number = Date.now()): MintedMediaToken {
  const index = windowIndex(at);
  return {
    token: tokenForWindow(index),
    // Valid through the following window, since verification accepts index-1.
    expiresAt: (index + 2) * WINDOW_MS,
  };
}

/** Constant-time check against the current and previous window. */
export function isValidMediaAccessToken(
  token: string | undefined,
  at: number = Date.now()
): boolean {
  if (!token) return false;
  const received = Buffer.from(token);
  // Length is checked per candidate below; both are fixed-width hex, so a
  // wrong-length token short-circuits without a compare.
  const index = windowIndex(at);
  for (const candidate of [tokenForWindow(index), tokenForWindow(index - 1)]) {
    const expected = Buffer.from(candidate);
    if (received.length === expected.length && timingSafeEqual(received, expected)) {
      return true;
    }
  }
  return false;
}

/** Read the token out of a request's query string. */
export function mediaAccessTokenFromQuery(query: unknown): string | undefined {
  if (!query || typeof query !== 'object') return undefined;
  const raw = (query as Record<string, unknown>).k;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}
