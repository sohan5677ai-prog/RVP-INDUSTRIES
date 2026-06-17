import type { Request, Response, NextFunction } from 'express';
import type { Role } from '@prisma/client';
import { verifyToken, type JwtPayload } from '../lib/jwt.js';
import { HttpError } from '../lib/httpError.js';

// Augment Express Request with the authenticated user.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

/** Reject unless a valid Bearer token is present. Attaches req.user. */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new HttpError(401, 'Missing or malformed Authorization header');
  }
  const token = header.slice('Bearer '.length);
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    throw new HttpError(401, 'Invalid or expired token');
  }
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
