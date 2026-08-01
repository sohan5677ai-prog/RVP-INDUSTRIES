import { logger } from '../lib/logger.js';
import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../lib/httpError.js';

/** Central error handler. Maps HttpError and ZodError to clean JSON responses. */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
) {
  const isZodError = err instanceof ZodError || (err && typeof err === 'object' && (err as any).name === 'ZodError');
  if (isZodError) {
    const zErr = err as any;
    const details = typeof zErr.flatten === 'function' ? zErr.flatten() : zErr.issues;
    return res.status(400).json({ error: 'Validation failed', details });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  logger.error(err);
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  return res.status(500).json({ error: 'Internal server error', message, stack });
}
