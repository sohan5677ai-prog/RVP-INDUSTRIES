import type { Request, Response, NextFunction } from 'express';
import { HttpError } from '../lib/httpError.js';

/**
 * Auth for the office-PC Tally agent. The agent runs on a different machine and
 * must NOT hold the ERP's JWT secret, so instead of a user JWT it presents a
 * shared service token (TALLY_SYNC_TOKEN), compared here. Keep this token secret
 * and rotate it by changing the env var on both the server and the agent.
 */
export function requireTallyAgent(req: Request, _res: Response, next: NextFunction) {
  const expected = process.env.TALLY_SYNC_TOKEN;
  if (!expected) {
    throw new HttpError(500, 'TALLY_SYNC_TOKEN is not configured on the server');
  }
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  if (!token || token !== expected) {
    throw new HttpError(401, 'Invalid Tally agent token');
  }
  next();
}
