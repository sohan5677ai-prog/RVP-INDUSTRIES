/**
 * API origin and token storage.
 *
 * Split out of api.ts so that modules api.ts itself depends on can read the
 * base URL and the token without an import cycle. api.ts re-exports all of it,
 * so `import { API_BASE, getToken } from './api'` keeps working everywhere.
 */

export const API_BASE = (
  import.meta.env.VITE_API_URL && import.meta.env.VITE_API_URL !== '/api'
    ? import.meta.env.VITE_API_URL
    : typeof window !== 'undefined' &&
      window.location.hostname !== 'localhost' &&
      window.location.hostname !== '127.0.0.1'
    ? 'https://rvp-server.onrender.com/api'
    : '/api'
).replace(/\/+$/, '');

const TOKEN_KEY = 'rvp_token';
const REFRESH_KEY = 'rvp_refresh';
const DEVICE_KEY = 'rvp_device_id';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY);
}

/** Store both halves of a freshly issued pair. */
export function setSession(token: string, refreshToken?: string | null) {
  setToken(token);
  if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
}

export function clearSession() {
  clearToken();
  localStorage.removeItem(REFRESH_KEY);
}

/**
 * Authorization header for a hand-rolled fetch, empty when signed out.
 *
 * For calls that go out through api() this is already handled. It exists for
 * the few that cannot — the scale writes in scaleContext, which post at up to
 * several times a second and so bypass api()'s deadline wrapper.
 */
export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Exchange the refresh token for a new pair.
 *
 * Access tokens now last fifteen minutes rather than seven days, so this runs
 * roughly every quarter of an hour of use. Single-flight on purpose: a page
 * that fires six queries at once would otherwise send six refreshes, and since
 * the server rotates the token on every use and treats a replayed one as theft,
 * five of them would be rejected and the session killed. One promise, shared.
 *
 * Deliberately a bare fetch rather than api(): a 401 here must not recurse
 * back into the refresh path.
 */
let refreshInFlight: Promise<string | null> | null = null;

export function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;

  const refreshToken = getRefreshToken();
  const deviceId = localStorage.getItem(DEVICE_KEY);
  if (!refreshToken || !deviceId) return Promise.resolve(null);

  refreshInFlight = fetch(`${API_BASE}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken, deviceId }),
    cache: 'no-store',
  })
    .then(async (res) => {
      if (!res.ok) return null;
      const data = (await res.json()) as { token?: string; refreshToken?: string };
      if (!data.token) return null;
      setSession(data.token, data.refreshToken);
      return data.token;
    })
    .catch(() => null)
    .finally(() => {
      refreshInFlight = null;
    });

  return refreshInFlight;
}
