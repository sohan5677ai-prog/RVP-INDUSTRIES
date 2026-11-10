import { API_BASE, getToken } from './apiBase';

/**
 * Capability token for the weighbridge media endpoints.
 *
 * The camera frames and the scale SSE stream are consumed by `<img src>` and
 * `EventSource`, neither of which can send an Authorization header — which is
 * why those routes used to be open to anyone. The server now accepts a
 * short-lived token in `?k=`; this module fetches one, keeps it, and appends
 * it to those URLs.
 *
 * Everything else (plain fetch calls) sends the Bearer header instead and does
 * not need this.
 */

interface MintedToken {
  token: string;
  expiresAt: number;
}

const STORAGE_KEY = 'rvp_media_token';

let current: MintedToken | null = null;
let inFlight: Promise<string | null> | null = null;
const listeners = new Set<(token: string | null) => void>();

/** Re-mint a little early, so a long-open screen never uses a dead token. */
const RENEW_MARGIN_MS = 10 * 60 * 1000;

function isUsable(t: MintedToken | null): t is MintedToken {
  return !!t && t.expiresAt - RENEW_MARGIN_MS > Date.now();
}

function readStored(): MintedToken | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MintedToken;
    return typeof parsed?.token === 'string' && typeof parsed?.expiresAt === 'number'
      ? parsed
      : null;
  } catch {
    // Private windows and blocked site data both throw here; the token is a
    // cache, so carry on without it.
    return null;
  }
}

function store(t: MintedToken | null) {
  try {
    if (t) localStorage.setItem(STORAGE_KEY, JSON.stringify(t));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* not fatal - see readStored */
  }
}

function publish(token: string | null) {
  for (const fn of listeners) fn(token);
}

/**
 * The token we hold right now, or null. Synchronous, so a render that builds
 * an `<img src>` can use it; pair with subscribe() to re-render once it lands.
 */
export function peekMediaToken(): string | null {
  if (!current) current = readStored();
  return isUsable(current) ? current.token : null;
}

/** Fetch a token if we do not have a usable one. Safe to call repeatedly. */
export function ensureMediaToken(): Promise<string | null> {
  const held = peekMediaToken();
  if (held) return Promise.resolve(held);
  // Nothing to mint against until the user is signed in.
  const auth = getToken();
  if (!auth) return Promise.resolve(null);
  if (inFlight) return inFlight;

  // A bare fetch rather than api(): api.ts depends on this module for
  // getScaleApiUrl, so importing it back here would make a cycle.
  inFlight = fetch(`${API_BASE}/weighbridge/media-token`, {
    headers: { Authorization: `Bearer ${auth}` },
    cache: 'no-store',
  })
    .then((res) => (res.ok ? res.json() : null))
    .then((minted: MintedToken | null) => {
      if (!minted || typeof minted.token !== 'string') return null;
      current = minted;
      store(minted);
      publish(minted.token);
      return minted.token;
    })
    .catch(() => null)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Drop the token — called on sign-out, since it is no longer re-mintable. */
export function clearMediaToken() {
  current = null;
  store(null);
  publish(null);
}

export function subscribeMediaToken(fn: (token: string | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Append the token to a media URL. Returns the URL unchanged when we have
 * none — the request then fails closed on the server rather than silently
 * looking like it worked.
 */
export function withMediaToken(url: string): string {
  const token = peekMediaToken();
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}k=${encodeURIComponent(token)}`;
}
