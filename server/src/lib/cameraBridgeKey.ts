import type { Request } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError } from './httpError.js';

/**
 * The shared secret the cabin's CCTV bridge presents as `x-cctv-bridge-key`.
 *
 * Lifted out of weighbridge.controller.ts so route middleware can check it
 * without pulling in that whole controller (index.ts deliberately imports it
 * lazily to keep boot light).
 */
export function getExpectedBridgeKey(): string {
  if (process.env.CCTV_BRIDGE_KEY && process.env.CCTV_BRIDGE_KEY.length >= 24) {
    return process.env.CCTV_BRIDGE_KEY;
  }
  // Derived from the JWT secret when CCTV_BRIDGE_KEY is unset. There is
  // deliberately no literal fallback here: a hardcoded default in the repo is a
  // published credential, and assertJwtSecret() already refuses to boot without
  // JWT_SECRET, so this throw is unreachable in a running server.
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 16) {
    throw new HttpError(
      500,
      'Camera bridge is not configured: set CCTV_BRIDGE_KEY (or JWT_SECRET) on the server'
    );
  }
  return createHmac('sha256', secret).update('rvp-cctv-bridge-v1').digest('hex');
}

/** Constant-time check of the bridge key on an incoming request. */
export function isTrustedCameraBridge(req: Request): boolean {
  // Cheap rejection first, so a caller that presents no key at all is simply
  // "not the bridge" rather than a server-configuration error.
  const received = req.header('x-cctv-bridge-key');
  if (!received || received.length < 24) return false;
  const expected = getExpectedBridgeKey();
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
