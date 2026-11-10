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

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
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
