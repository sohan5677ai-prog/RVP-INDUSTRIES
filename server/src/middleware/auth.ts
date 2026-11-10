import type { Request, Response, NextFunction } from 'express';
import type { Role } from '@prisma/client';
import {
  verifyAccessToken,
  tokenPredatesPasswordChange,
  type AccessTokenPayload,
} from '../lib/tokens.js';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import {
  IDLE_TIMEOUT_MS,
  LAST_SEEN_WRITE_INTERVAL_MS,
  SERVICE_SESSION_ID,
  liveSessionCutoff,
} from '../lib/sessionPolicy.js';

// Augment Express Request with the authenticated user.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AccessTokenPayload;
    }
  }
}

/**
 * sid -> epoch ms of the last lastSeenAt we wrote. Lets us skip the session
 * round-trip on back-to-back requests; a session revoked elsewhere is noticed
 * within LAST_SEEN_WRITE_INTERVAL_MS (immediately if it was this process that
 * revoked it, via forgetSession).
 *
 * Note what this cache does and does not cover. The 15-minute access token is
 * what bounds the damage of a revoked credential: the checks below run at most
 * every 30 seconds, but a revoked session cannot be refreshed at all, so it
 * dies within one token lifetime regardless.
 */
const lastSeenCache = new Map<string, number>();

export function touchSession(sid: string, at: Date) {
  if (lastSeenCache.size > 500) {
    const cutoff = Date.now() - IDLE_TIMEOUT_MS;
    for (const [key, ts] of lastSeenCache) if (ts < cutoff) lastSeenCache.delete(key);
  }
  lastSeenCache.set(sid, at.getTime());
}

export function forgetSession(sid: string) {
  lastSeenCache.delete(sid);
}

async function authenticate(req: Request): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new HttpError(401, 'Missing or malformed Authorization header');
  }
  const token = header.slice('Bearer '.length);

  let payload: AccessTokenPayload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    // Covers both a forged token and an expired one. The client tells them
    // apart by trying /auth/refresh: if that works the token was merely old.
    throw new HttpError(401, 'Invalid or expired token');
  }
  req.user = payload;

  // Tokens minted before device sessions existed carry no sid; make the holder
  // sign in again so they get a real session row.
  if (!payload.sid) throw new HttpError(401, 'Session ended. Please sign in again.');
  // The Slack bot and the kata cabin screen. No session row, no idle timeout,
  // and no password to have changed - see signServiceToken.
  if (payload.sid === SERVICE_SESSION_ID) return;

  const now = Date.now();
  const wroteAt = lastSeenCache.get(payload.sid);
  if (wroteAt !== undefined && now - wroteAt < LAST_SEEN_WRITE_INTERVAL_MS) return;

  // One query for the session and the user state it depends on, rather than
  // two round-trips per request.
  const session = await prisma.userSession.findUnique({
    where: { id: payload.sid },
    select: {
      id: true,
      lastSeenAt: true,
      absoluteExpiresAt: true,
      user: {
        select: { passwordChangedAt: true, disabledAt: true, role: true, mustChangePassword: true },
      },
    },
  });
  if (!session) {
    forgetSession(payload.sid);
    throw new HttpError(401, 'Session ended. Please sign in again.');
  }

  const nowDate = new Date(now);

  // Offboarding is immediate: a disabled account's live sessions stop working
  // on their next request, without waiting for them to go idle.
  if (session.user.disabledAt) {
    await dropSession(session.id);
    throw new HttpError(401, 'This account has been disabled.');
  }

  // A password change signs out every other device. This is the check that
  // makes that true - without it, tokens issued before the change would keep
  // working until they expired.
  if (tokenPredatesPasswordChange(payload, session.user.passwordChangedAt)) {
    await dropSession(session.id);
    throw new HttpError(401, 'Your password was changed. Please sign in again.');
  }

  // Hard stop on session age regardless of activity (plan item 1.5).
  if (session.absoluteExpiresAt && session.absoluteExpiresAt <= nowDate) {
    await dropSession(session.id);
    throw new HttpError(401, 'Session expired. Please sign in again.');
  }

  // Belt-and-braces for the browser's own idle timer: a tab that sat quiet past
  // the idle window doesn't get to pick up where it left off.
  if (session.lastSeenAt < liveSessionCutoff(nowDate)) {
    await dropSession(session.id);
    throw new HttpError(401, 'Signed out after a period of inactivity. Please sign in again.');
  }

  // A role changed under a live token: trust the database, not the token. The
  // token is reissued with the new role on the next refresh.
  req.user = { ...payload, role: session.user.role };

  await prisma.userSession.update({ where: { id: session.id }, data: { lastSeenAt: nowDate } });
  touchSession(session.id, nowDate);
}

async function dropSession(sid: string): Promise<void> {
  await prisma.userSession.deleteMany({ where: { id: sid } });
  forgetSession(sid);
}

/** Reject unless a valid Bearer token with a live device session is present. */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  authenticate(req).then(() => next(), next);
}

/** Reject unless the authenticated user has one of the allowed roles. */
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw new HttpError(401, 'Not authenticated');
    if (!roles.includes(req.user.role)) {
      throw new HttpError(403, 'Insufficient permissions');
    }
    next();
  };
}
