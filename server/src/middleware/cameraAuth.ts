import type { Request, Response, NextFunction } from 'express';
import { requireAuth } from './auth.js';
import { isTrustedCameraBridge } from '../lib/cameraBridgeKey.js';

/**
 * Accept either a signed-in user or the cabin's CCTV bridge.
 *
 * Used for the camera routes that are mounted outside the authenticated router
 * (they sit in front of the API rate limiter so a live MJPEG stream cannot
 * exhaust it). They used to be reachable by anyone on the internet: a browser
 * tab pointed at the API could watch the weighbridge, and POST /detect-plate
 * would run a billed Gemini call for an anonymous caller.
 *
 * Both callers that matter already send credentials — the client goes through
 * api() with a Bearer token, the bridge sends x-cctv-bridge-key — so this adds
 * no new client work.
 */
export function requireAuthOrCameraBridge(req: Request, res: Response, next: NextFunction) {
  if (isTrustedCameraBridge(req)) return next();
  return requireAuth(req, res, next);
}
