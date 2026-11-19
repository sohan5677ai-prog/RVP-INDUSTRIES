import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { Role } from '@prisma/client';

/**
 * Who is making the current request, available anywhere without passing it
 * down.
 *
 * The audit log is written by a Prisma extension at the database client, which
 * sees the query but has no idea which HTTP request caused it. Threading the
 * actor through every service signature would be hundreds of call sites and
 * one forgotten parameter away from an anonymous audit row - so the context
 * rides in AsyncLocalStorage instead, set once per request.
 *
 * A write with no context is not an error: cron jobs, the boot-time bootstrap
 * and maintenance scripts all write legitimately outside a request. Those rows are
 * recorded with a null user and a source, which is more honest than attributing
 * them to whoever happened to be signed in.
 */

export interface RequestContext {
  userId?: string;
  userName?: string;
  userRole?: Role;
  ip?: string;
  userAgent?: string;
  /** Ties every audit row written while serving one request together. */
  requestId: string;
  method?: string;
  path?: string;
  /** Where a write came from when it was not an HTTP request. */
  source?: 'cron' | 'boot' | 'script';
  /**
   * Set while applying an approved change, so the audit row can say it was
   * released by someone other than the person who asked for it.
   */
  onBehalfOf?: { userId: string; userName?: string | null };
}

const storage = new AsyncLocalStorage<RequestContext>();

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Run `fn` with a context. Used by the middleware and by background jobs. */
export function withContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** A context for work that happens outside any HTTP request. */
export function backgroundContext(
  source: NonNullable<RequestContext['source']>
): RequestContext {
  return { requestId: randomUUID(), source };
}

/**
 * Express middleware establishing the context for the rest of the request.
 *
 * Mounted before the routers but after requireAuth where possible, so
 * `req.user` is populated. On the unauthenticated routes it still runs, giving
 * a requestId and an IP - a failed login has to be audited too, and that is
 * precisely the case where there is no user.
 */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction) {
  const context: RequestContext = {
    requestId: randomUUID(),
    ip: req.ip?.slice(0, 64),
    userAgent: req.headers['user-agent']?.slice(0, 255),
    method: req.method,
    path: (req.originalUrl ?? req.path)?.split('?')[0]?.slice(0, 255),
  };
  // Surfaced on the response so a user reporting a problem can quote one id
  // that finds every audit row for that action.
  res.setHeader('X-Request-Id', context.requestId);
  storage.run(context, () => next());
}

/**
 * Fill in the user once authentication has run.
 *
 * Mutates the existing store rather than opening a new one: starting a fresh
 * context here would give the authenticated half of the request a different
 * requestId from the half before it.
 */
export function setContextUser(user: {
  userId: string;
  userName?: string | null;
  role: Role;
}): void {
  const store = storage.getStore();
  if (!store) return;
  store.userId = user.userId;
  store.userName = user.userName ?? undefined;
  store.userRole = user.role;
}

/** Note that this work is being done on someone else's behalf. */
export function setOnBehalfOf(actor: { userId: string; userName?: string | null }): void {
  const store = storage.getStore();
  if (store) store.onBehalfOf = actor;
}
