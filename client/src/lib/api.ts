import { withRequestDeadline } from './requestDeadline';
import { getLocalBridgeOrigin } from './localBridge';
import {
  API_BASE,
  getToken,
  setToken,
  clearToken,
  clearSession,
  getRefreshToken,
  refreshAccessToken,
  setSession,
} from './apiBase';
import { withMediaToken } from './mediaToken';

// Re-exported so existing imports from './api' keep working; the definitions
// live in apiBase.ts so mediaToken.ts can use them without an import cycle.
export { API_BASE, getToken, setToken, clearToken, clearSession, setSession, getRefreshToken };

/**
 * Paths `cctv-bridge.mjs` serves itself on the cabin LAN.
 *
 * Camera frames are the whole of our Render bandwidth bill - they are JPEGs,
 * so nothing compresses them - and the bridge has the exact same bytes sitting
 * in RAM on the same machine. Everything else (the scale endpoints, and the
 * tiny 10-second `/cctv/status` poll whose cloud payload carries relay
 * diagnostics the bridge does not report) stays on Render.
 */
const LOCAL_BRIDGE_PATHS = [
  '/weighbridge/cctv/snapshot',
  '/weighbridge/cctv/stream',
];

/**
 * Media paths the server will only serve to a credentialed caller. They are
 * loaded by `<img src>` and `EventSource`, which cannot send an Authorization
 * header, so the capability token goes in the query string instead. See
 * server/src/middleware/mediaAuth.ts.
 *
 * Only reads appear here. /scale/broadcast and /scale/config are writes and
 * are refused with a query token by design, so they must keep using fetch with
 * the Bearer header.
 */
const MEDIA_TOKEN_PATHS = [
  '/weighbridge/cctv/snapshot',
  '/weighbridge/cctv/stream',
  '/weighbridge/cctv/status',
  '/weighbridge/snapshots/',
  '/weighbridge/scale/live',
  '/weighbridge/scale/stream',
];

export function getScaleApiUrl(path: string): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const needsToken = MEDIA_TOKEN_PATHS.some((p) => cleanPath.startsWith(p));

  // Serve camera frames off the LAN when the bridge is running on this PC.
  // Costs no Render egress at all, and arrives in under a millisecond.
  // The bridge matches on pathname and reads only `cam`, so the extra token
  // parameter is ignored there - harmless, and it keeps one code path.
  const localOrigin = getLocalBridgeOrigin();
  if (localOrigin && LOCAL_BRIDGE_PATHS.some((p) => cleanPath.startsWith(p))) {
    return `${localOrigin}/api${cleanPath}`;
  }

  const url =
    typeof window !== 'undefined' &&
    window.location.hostname !== 'localhost' &&
    window.location.hostname !== '127.0.0.1'
      ? `https://rvp-server.onrender.com/api${cleanPath}`
      : `${API_BASE}${cleanPath}`;

  return needsToken ? withMediaToken(url) : url;
}

const BASE = API_BASE;

export class ApiError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

interface ApiOptions {
  method?: string;
  body?: unknown;
  /** Set true for multipart/form-data (body must be a FormData). */
  multipart?: boolean;
  signal?: AbortSignal;
  /** Override for long-running operations; zero disables the deadline. */
  timeoutMs?: number;
}

/**
 * Endpoints that must never trigger a refresh-and-retry: the refresh itself,
 * and the unauthenticated credential endpoints. A 401 from any of these is a
 * real answer, not an expired access token.
 */
const NO_REFRESH_PATHS = [
  '/auth/refresh',
  '/auth/login',
  '/auth/mfa/verify',
  '/auth/kiosk',
  '/auth/forgot-password',
  '/auth/reset-password',
];

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  return apiOnce<T>(path, opts, true);
}

async function apiOnce<T>(path: string, opts: ApiOptions, mayRetry: boolean): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let body: BodyInit | undefined;
  if (opts.multipart) {
    body = opts.body as FormData;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }

  return withRequestDeadline(opts.signal, opts.timeoutMs ?? 60_000, async (signal) => {
    const res = await fetch(`${BASE}${path}`, {
      signal,
      method: opts.method ?? 'GET',
      headers,
      body,
    });

    // A 401 now usually means nothing worse than a fifteen-minute access token
    // having expired, so try the refresh token once before giving up. Only if
    // that fails is the session genuinely gone (revoked elsewhere, idle window
    // lapsed, password changed, account disabled), and only then do we sign
    // out - broadcasting it so AuthProvider drops the user without a reload.
    if (res.status === 401) {
      const refreshable =
        mayRetry && !!token && !!getRefreshToken() && !NO_REFRESH_PATHS.includes(path);
      if (refreshable && (await refreshAccessToken())) {
        return apiOnce<T>(path, opts, false);
      }
      clearSession();
      if (token && path !== '/auth/login') {
        window.dispatchEvent(new Event('auth:unauthorized'));
      }
    }

    // 402 = the licensing gate rejected the call (subscription expired / stopped).
    // Broadcast it so SubscriptionBoundary can flip to the paywall without a
    // manual refresh, even if this particular call's error is swallowed.
    if (res.status === 402) {
      window.dispatchEvent(new Event('subscription:locked'));
    }

    // 503 = Maintenance mode active (or server temporarily unavailable).
    // If flagged as maintenance, broadcast immediately so MaintenanceBoundary triggers.
    if (res.status === 503 && res.headers.get('X-Maintenance-Mode') === '1') {
      window.dispatchEvent(new Event('maintenance:active'));
    }

    if (!res.ok) {
      let message = res.statusText;
      let details: unknown;
      try {
        const data = await res.json();
        message = data.error ?? message;
        details = data.details ?? data.maintenance;
        if (data.code === 'MAINTENANCE_MODE' || data.maintenance) {
          window.dispatchEvent(
            new CustomEvent('maintenance:active', { detail: data.maintenance })
          );
        }
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(res.status, message, details);
    }

    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }, !['GET', 'HEAD'].includes((opts.method ?? 'GET').toUpperCase()));
}

/**
 * Fetch a binary endpoint (PDF/image) with the auth header attached and hand
 * back a Blob. Plain <a href> links can't carry the bearer token.
 */
export async function apiBlob(path: string, opts: Pick<ApiOptions, 'signal' | 'timeoutMs'> = {}): Promise<Blob> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  return withRequestDeadline(opts.signal, opts.timeoutMs ?? 120_000, async (signal) => {
    const res = await fetch(`${BASE}${path}`, { headers, signal });
    if (res.status === 401) {
      clearToken();
      if (token) window.dispatchEvent(new Event('auth:unauthorized'));
    }
    if (!res.ok) throw new ApiError(res.status, res.statusText);
    return res.blob();
  });
}

export function getErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.details) {
    const details = err.details as any;
    if (details.fieldErrors && typeof details.fieldErrors === 'object') {
      const messages = Object.entries(details.fieldErrors)
        .filter(([_, errors]) => Array.isArray(errors) && errors.length > 0)
        .map(([field, errors]) => {
          const fieldName = field.replace(/([A-Z])/g, ' $1').toLowerCase();
          const cleanErrors = (errors as string[]).join(', ');
          return `${fieldName}: ${cleanErrors}`;
        })
        .join('; ');
      if (messages) return `${err.message}: ${messages}`;
    }
    if (Array.isArray(details.formErrors) && details.formErrors.length > 0) {
      return `${err.message}: ${details.formErrors.join(', ')}`;
    }
    if (Array.isArray(details) && details.length > 0) {
      const messages = details
        .map((d: any) => `${d.path ? d.path.join('.') : 'field'}: ${d.message}`)
        .join('; ');
      if (messages) return `${err.message}: ${messages}`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}
