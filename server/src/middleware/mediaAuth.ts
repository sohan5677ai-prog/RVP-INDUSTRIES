import type { Request, Response, NextFunction } from 'express';
import { requireAuth } from './auth.js';
import { isTrustedCameraBridge } from '../lib/cameraBridgeKey.js';
import { HttpError } from '../lib/httpError.js';
import {
  isValidMediaAccessToken,
  mediaAccessTokenFromQuery,
} from '../lib/mediaAccessToken.js';

/**
 * Gates for the weighbridge media surface — live camera frames, stored
 * snapshots, and the scale's live reading and SSE stream.
 *
 * These routes are mounted at app level, in front of the API rate limiter, so
 * that a long-lived MJPEG or SSE connection cannot exhaust it. That placement
 * also put them in front of requireAuth, which is why every one of them was
 * reachable anonymously: a stranger who knew the host could watch the
 * premises, read live scale weights, and — on the two POSTs — inject a weight
 * reading or reconfigure the serial port.
 *
 * Two gates, because reads and writes can afford different credentials.
 */

/**
 * Reads: the cabin bridge key, a Bearer token, or a media capability token in
 * `?k=`. The query token exists only because `<img src>` and `EventSource`
 * cannot send headers.
 */
export function requireMediaRead(req: Request, res: Response, next: NextFunction) {
  if (isTrustedCameraBridge(req)) return next();
  if (isValidMediaAccessToken(mediaAccessTokenFromQuery(req.query))) return next();
  return requireAuth(req, res, next);
}

/**
 * Writes: the cabin bridge key or a Bearer token only.
 *
 * Deliberately NOT the query token. A token that travels in a URL ends up in
 * browser history, referrers and proxy logs, so it must never be enough to
 * change the weight the operator sees or to reconfigure the scale. Every real
 * writer can send a header: the cabin pushes readings with fetch(), and the
 * bridge has its key.
 */
export function requireMediaWrite(req: Request, res: Response, next: NextFunction) {
  if (isTrustedCameraBridge(req)) return next();
  if (mediaAccessTokenFromQuery(req.query)) {
    // Say why, rather than falling through to a bare "missing Authorization
    // header" that would send someone hunting for the wrong problem.
    return next(
      new HttpError(403, 'A media access token cannot authorise this request; sign in instead')
    );
  }
  return requireAuth(req, res, next);
}
