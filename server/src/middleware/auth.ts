import type { Request, Response, NextFunction } from 'express';
import type { Role } from '@prisma/client';
import { verifyToken, type JwtPayload } from '../lib/jwt.js';
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
      user?: JwtPayload;
    }
  }
}

/**
 * sid -> epoch ms of the last lastSeenAt we wrote. Lets us skip the session
 * round-trip on back-to-back requests; a session revoked elsewhere is noticed
 * within LAST_SEEN_WRITE_INTERVAL_MS (immediately if it was this process that
 * revoked it, via forgetSession).
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

  let payload: JwtPayload;
  try {
    payload = verifyToken(token);
  } catch {
    throw new HttpError(401, 'Invalid or expired token');
  }
  req.user = payload;

  // Tokens minted before device sessions existed carry no sid; make the holder
  // sign in again so they get a real session row.
  if (!payload.sid) throw new HttpError(401, 'Session ended. Please sign in again.');
  if (payload.sid === SERVICE_SESSION_ID) return;

  const now = Date.now();
  const wroteAt = lastSeenCache.get(payload.sid);
  if (wroteAt !== undefined && now - wroteAt < LAST_SEEN_WRITE_INTERVAL_MS) return;

  const session = await prisma.userSession.findUnique({
    where: { id: payload.sid },
    select: { id: true, lastSeenAt: true },
  });
  if (!session) {
    forgetSession(payload.sid);
    throw new HttpError(401, 'Session ended. Please sign in again.');
  }

  // Belt-and-braces for the browser's own idle timer: a tab that sat quiet past
  // the idle window doesn't get to pick up where it left off.
  if (session.lastSeenAt < liveSessionCutoff(new Date(now))) {
    await prisma.userSession.deleteMany({ where: { id: session.id } });
    forgetSession(payload.sid);
    throw new HttpError(401, 'Signed out after a period of inactivity. Please sign in again.');
  }

  const seenAt = new Date(now);
  await prisma.userSession.update({ where: { id: session.id }, data: { lastSeenAt: seenAt } });
  touchSession(session.id, seenAt);
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
