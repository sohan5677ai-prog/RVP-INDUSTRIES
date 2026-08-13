const BASE = import.meta.env.VITE_API_URL ?? '/api';

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
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let body: BodyInit | undefined;
  if (opts.multipart) {
    body = opts.body as FormData;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body,
  });

  // A 401 on an authenticated call means the session is gone (revoked from
  // another device, or timed out). Broadcast it so AuthProvider drops the user
  // and the app falls back to the login screen without a manual refresh.
  if (res.status === 401) {
    clearToken();
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

  if (!res.ok) {
    let message = res.statusText;
    let details: unknown;
    try {
      const data = await res.json();
      message = data.error ?? message;
      details = data.details;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message, details);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/**
 * Fetch a binary endpoint (PDF/image) with the auth header attached and hand
 * back a Blob. Plain <a href> links can't carry the bearer token.
 */
export async function apiBlob(path: string): Promise<Blob> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, { headers });
  if (res.status === 401) clearToken();
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  return res.blob();
}

export function getErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.details) {
    const details = err.details as any;
    if (details.fieldErrors) {
      const messages = Object.entries(details.fieldErrors)
        .map(([field, errors]) => {
          const fieldName = field.replace(/([A-Z])/g, ' $1').toLowerCase();
          const cleanErrors = (errors as string[]).join(', ');
          return `${fieldName}: ${cleanErrors}`;
        })
        .join('; ');
      return `${err.message}: ${messages}`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}
