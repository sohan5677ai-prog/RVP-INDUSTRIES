import type { Request, Response, NextFunction } from 'express';
import { HttpError } from '../lib/httpError.js';
import { logger } from '../lib/logger.js';
import { SERVICE_SESSION_ID } from '../lib/sessionPolicy.js';
import { resolveRoutePermission } from '../lib/routePermissions.js';
import { permissionsFor, recordDenial } from '../services/permission.service.js';
import { rbacEnforced } from './permission.js';

/**
 * Applies the route→permission table to every authenticated request.
 *
 * Mounted once, just after requireAuth, instead of adding a guard to each of
 * 415 routes. That choice is deliberate: it meant this phase changed no route
 * file at all, so it cannot have broken a route by getting its middleware
 * order wrong, and the whole authorization model stays readable in one table.
 *
 * Unmatched routes are denied when enforcing (deny by default, plan item 6.7).
 * The coverage test keeps that from being a surprise: a route with no rule
 * fails CI long before it can fail a user.
 */
export function enforceRoutePermissions(req: Request, _res: Response, next: NextFunction) {
  const user = req.user;
  if (!user) return next(new HttpError(401, 'Not authenticated'));

  // The Slack bot and the kata cabin. Neither is a person with a role; the
  // cabin is confined to the weighbridge by its scope check, which runs first.
  if (user.sid === SERVICE_SESSION_ID) return next();

  // `req.path` here is relative to the mount (`/api`), which is what the rules
  // are written against. Query strings never participate in matching.
  const path = req.path || '/';
  const resolution = resolveRoutePermission(req.method, path);
  const enforced = rbacEnforced();

  // No rule at all. In audit mode say so loudly - this is the signal that the
  // table has a hole, and it is far better found here than by a user.
  if (!resolution.matched) {
    logger.warn(`[rbac] no permission rule for ${req.method} ${path}`);
    void recordDenial({
      userId: user.userId,
      role: user.role,
      permission: '(no rule)',
      method: req.method,
      path,
      enforced,
    });
    if (enforced) {
      return next(new HttpError(403, 'You do not have permission to do that.'));
    }
    return next();
  }

  // Explicitly open to any authenticated user - the caller's own account.
  if (resolution.permission === null) return next();

  const permission = resolution.permission;

  permissionsFor(user.role).then(
    (held) => {
      if (held.has(permission)) return next();

      void recordDenial({
        userId: user.userId,
        role: user.role,
        permission,
        method: req.method,
        path,
        enforced,
      });

      if (!enforced) {
        logger.warn(
          `[rbac audit] ${user.role} lacks ${permission} for ${req.method} ${path} - allowed (audit mode)`
        );
        return next();
      }
      next(
        new HttpError(
          403,
          'You do not have permission to do that. Ask an administrator if you need it.'
        )
      );
    },
    (err) => {
      // permissionsFor already falls back to the code defaults on a database
      // error, so reaching here means something unexpected. Fail closed when
      // enforcing, open when only observing.
      logger.error('route permission check failed', err);
      next(enforced ? new HttpError(403, 'Permission check failed') : undefined);
    }
  );
}
