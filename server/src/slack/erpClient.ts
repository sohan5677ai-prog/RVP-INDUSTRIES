import { signToken, type JwtPayload } from '../lib/jwt.js';

/**
 * Internal HTTP client the Slack bot uses to drive the ERP. Rather than calling
 * controllers directly (they are coupled to Express req/res), the bot re-posts
 * through the existing REST API over localhost, authenticated as the mapped ERP
 * user. This reuses all validation, ledger posting, inventory updates and file
 * persistence with zero controller changes.
 */

const API_BASE = `http://localhost:${process.env.PORT ?? 4000}/api`;

/** The minimal ERP user identity the bot acts on behalf of. */
export interface ErpUser {
  userId: string;
  role: JwtPayload['role'];
}

/** A file to forward in a multipart request (e.g. the stock-in invoice). */
export interface UploadFile {
  field: string; // form field name the endpoint expects (e.g. "invoice")
  buffer: Buffer;
  filename: string;
  mimetype: string;
}

/** Error carrying the ERP API's HTTP status and message for friendly Slack replies. */
export class ErpApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ErpApiError';
  }
}

/** Mint a short-lived JWT so the request is attributed to this ERP user. */
function mintToken(user: ErpUser): string {
  return signToken({ userId: user.userId, role: user.role });
}

async function parseOrThrow(res: globalThis.Response): Promise<any> {
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const message =
      (body && typeof body === 'object' && (body.message || body.error)) ||
      (typeof body === 'string' && body) ||
      `Request failed (${res.status})`;
    throw new ErpApiError(res.status, message);
  }
  return body;
}

export async function apiGet(path: string, user: ErpUser): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${mintToken(user)}` },
  });
  return parseOrThrow(res);
}

export async function apiPost(path: string, body: unknown, user: ErpUser): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${mintToken(user)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body ?? {}),
  });
  return parseOrThrow(res);
}

/**
 * POST multipart/form-data — used for endpoints behind multer (e.g. stock-in,
 * sale dispatch). String fields and uploaded files are appended to a FormData;
 * the runtime sets the multipart boundary automatically.
 */
export async function apiPostMultipart(
  path: string,
  fields: Record<string, string | number | undefined | null>,
  files: UploadFile[],
  user: ErpUser
): Promise<any> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) form.append(key, String(value));
  }
  for (const f of files) {
    const blob = new Blob([new Uint8Array(f.buffer)], { type: f.mimetype || 'application/octet-stream' });
    form.append(f.field, blob, f.filename);
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${mintToken(user)}` },
    body: form,
  });
  return parseOrThrow(res);
}
