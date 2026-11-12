import type { Request, Response, NextFunction } from 'express';
import { HttpError } from '../lib/httpError.js';
import { logger } from '../lib/logger.js';
import { SERVICE_SESSION_ID } from '../lib/sessionPolicy.js';
import type { Permission } from '../lib/permissions.js';
import { permissionsFor, recordDenial } from '../services/permission.service.js';

/**
 * Permission checks (plan item 2.1), with an audit mode.
 *
 * Before this, 201 write endpoints were guarded by nothing but "is signed in":
 * a shop-floor account could delete a payment or rewrite a party's bank
 * details. The permission map that fixes this touches 415 routes, and any one
 * of them mapped wrongly means somebody cannot do their job.
 *
 * So it ships in audit mode. `RBAC_ENFORCE` unset means every check is
 * evaluated and every would-be denial recorded, while the request proceeds.
 * Run a normal week, read PermissionDenial, correct the mapping, then set
 * `RBAC_ENFORCE=true`. This is the third time this pattern has been used here
 * — report-only CSP, MFA_ENFORCE — and for the same reason: a control that
 * locks out the people doing the work gets switched off wholesale, which is
 * worse than one that arrives a week later.
 */

export function rbacEnforced(): boolean {
  return process.env.RBAC_ENFORCE === 'true';
}

/**
 * Require one permission.
 *
 * Service principals (the Slack bot, the kata cabin) bypass this. They are not
 * people and hold no role in the permission sense; the cabin is already
 * confined to the weighbridge routes by its scope check, and the Slack bot
 * acts as the ERP user who invoked it, which is checked where the command is
 * handled.
 */
export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction) => {
    check(req, permission).then(
      (outcome) => {
        if (outcome === 'allow') return next();
        if (outcome === 'audit') return next();
        next(
          new HttpError(
            403,
            'You do not have permission to do that. Ask an administrator if you need it.'
          )
        );
      },
      // A failure inside the check itself is not a licence to proceed when
      // enforcing: fail closed there, and fail open while only auditing.
      (err) => {
        logger.error('permission check failed', err);
        next(rbacEnforced() ? new HttpError(403, 'Permission check failed') : undefined);
      }
    );
  };
}

/** Require any one of several permissions - for a route serving two jobs. */
export function requireAnyPermission(...permissions: Permission[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.all(permissions.map((p) => check(req, p))).then(
      (outcomes) => {
        if (outcomes.includes('allow') || outcomes.includes('audit')) return next();
        next(new HttpError(403, 'You do not have permission to do that.'));
      },
      (err) => {
        logger.error('permission check failed', err);
        next(rbacEnforced() ? new HttpError(403, 'Permission check failed') : undefined);
      }
    );
  };
}

type Outcome = 'allow' | 'deny' | 'audit';

async function check(req: Request, permission: Permission): Promise<Outcome> {
  const user = req.user;
  if (!user) throw new HttpError(401, 'Not authenticated');

  // Machine principals - see the note on requirePermission.
  if (user.sid === SERVICE_SESSION_ID) return 'allow';

  const held = await permissionsFor(user.role);
  if (held.has(permission)) return 'allow';

  const enforced = rbacEnforced();

  // Fire-and-forget. In audit mode especially, the point is to observe without
  // changing the timing or outcome of the request being observed.
  void recordDenial({
    userId: user.userId,
    role: user.role,
    permission,
    method: req.method,
    path: req.originalUrl?.split('?')[0] ?? req.path,
    enforced,
  });

  if (!enforced) {
    logger.warn(
      `[rbac audit] ${user.role} lacks ${permission} for ${req.method} ${req.path} - allowed (audit mode)`
    );
    return 'audit';
  }
  return 'deny';
}
