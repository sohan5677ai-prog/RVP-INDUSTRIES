import { logger } from '../lib/logger.js';
import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../lib/httpError.js';

/**
 * True when this process is serving real traffic. Checked per-request rather
 * than captured at import time so tests can flip NODE_ENV around a call.
 */
function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Central error handler. Maps HttpError and ZodError to clean JSON responses.
 *
 * An unexpected error returns nothing but a generic message in production.
 * It used to return `message` and `stack` to the caller, which handed anyone
 * who could provoke a 500 our file paths, SQL fragments and library internals.
 * The detail now goes to the logger only; outside production it is still
 * echoed to the response, because that is where it is actually useful.
 */
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
  // HttpError messages are written for the user ("Invalid credentials",
  // "This account is already signed in on 2 devices"), so they are safe to
  // return as-is - unlike the message on an error we did not expect.
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err instanceof SyntaxError && 'status' in err && (err as any).status === 400) {
    return res.status(400).json({ error: 'Malformed JSON payload in request body' });
  }

  logger.error(err);
  if (isProduction()) {
    return res.status(500).json({ error: 'Internal server error' });
  }
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  return res.status(500).json({ error: 'Internal server error', message, stack });
}
