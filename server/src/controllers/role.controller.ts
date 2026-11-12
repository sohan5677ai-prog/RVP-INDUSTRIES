import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Role } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSIONS,
  isPermission,
} from '../lib/permissions.js';
import {
  permissionsFor,
  resetRolePermissions,
  roleIsCustomised,
  setRolePermissions,
} from '../services/permission.service.js';
import {
  approveChange,
  listPending,
  rejectChange,
} from '../services/makerChecker.service.js';
import { rbacEnforced } from '../middleware/permission.js';
import { historyFor } from '../services/masterChange.service.js';
import type { MasterEntity } from '@prisma/client';

const ROLES: Role[] = ['ADMIN', 'USER', 'OWNER', 'DEVELOPER'];

const setPermissionsSchema = z.object({
  permissions: z.array(z.string()).max(500),
});

/**
 * The catalogue plus what each role currently holds.
 *
 * Also reports whether enforcement is on, because an admin editing grants with
 * `RBAC_ENFORCE` unset needs to know the changes are being recorded rather
 * than applied - otherwise the screen implies a protection that is not there.
 */
export async function getRoleMatrix(req: Request, res: Response) {
  const isDeveloper = req.user?.role === 'DEVELOPER';
  const visibleRoles = isDeveloper ? ROLES : ROLES.filter((r) => r !== 'DEVELOPER');

  const roles = await Promise.all(
    visibleRoles.map(async (role) => ({
      role,
      permissions: [...(await permissionsFor(role))].sort(),
      defaults: [...DEFAULT_ROLE_PERMISSIONS[role]].sort(),
      customised: await roleIsCustomised(role),
    }))
  );

  res.json({
    enforcing: rbacEnforced(),
    permissions: [...PERMISSIONS],
    roles,
  });
}

export async function updateRolePermissions(req: Request, res: Response) {
  const role = req.params.role as Role;
  if (!ROLES.includes(role)) throw new HttpError(404, 'No such role');

  // The vendor's own role is not editable from inside the app: locking
  // DEVELOPER out of a broken deployment leaves no way back in.
  if (role === 'DEVELOPER') {
    throw new HttpError(403, 'The developer role cannot be edited.');
  }

  const { permissions } = setPermissionsSchema.parse(req.body);
  const unknown = permissions.filter((p) => !isPermission(p));
  if (unknown.length) {
    throw new HttpError(400, `Unknown permissions: ${unknown.slice(0, 5).join(', ')}`);
  }

  // Refuse to leave nobody able to administer. Removing user.manage and
  // role.manage from every editable role would mean no one could put it back.
  if (role === 'ADMIN' && !permissions.includes('role.manage')) {
    throw new HttpError(
      400,
      'Admin must keep role.manage, or no one will be able to change permissions again.'
    );
  }

  const applied = await setRolePermissions(role, permissions, req.user?.userId);
  res.json({ role, permissions: [...applied].sort(), customised: true });
}

export async function resetRole(req: Request, res: Response) {
  const role = req.params.role as Role;
  if (!ROLES.includes(role)) throw new HttpError(404, 'No such role');
  await resetRolePermissions(role);
  res.json({ role, permissions: [...(await permissionsFor(role))].sort(), customised: false });
}

/**
 * What the audit mode has recorded, grouped so it can be acted on.
 *
 * This is the screen that makes the audit-mode rollout work: each row is
 * either a permission someone legitimately needs, or exactly the gap this
 * phase exists to close.
 */
export async function getPermissionDenials(_req: Request, res: Response) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const rows = await prisma.permissionDenial.groupBy({
    by: ['role', 'permission', 'method', 'path', 'enforced'],
    where: { createdAt: { gte: since } },
    _count: { _all: true },
    _max: { createdAt: true },
    orderBy: { _count: { id: 'desc' } },
    take: 200,
  });

  res.json(
    rows.map((r) => ({
      role: r.role,
      permission: r.permission,
      method: r.method,
      path: r.path,
      enforced: r.enforced,
      count: r._count._all,
      lastSeen: r._max.createdAt,
    }))
  );
}

/* ------------------------------------------------------- pending changes - */

export async function listPendingChanges(req: Request, res: Response) {
  const subject = typeof req.query.subject === 'string' ? req.query.subject : undefined;
  const rows = await listPending(subject);
  const mine = req.user?.userId;
  res.json(
    rows.map((r) => ({
      ...r,
      // The screen greys out your own requests rather than letting you click
      // and be refused - the rule is clearer stated up front.
      canDecide: r.requestedById !== mine,
    }))
  );
}

export async function approvePendingChange(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
    select: { name: true },
  });
  const updated = await approveChange(req.params.id, {
    userId: req.user.userId,
    name: user?.name ?? null,
    role: req.user.role,
  });
  res.json(updated);
}

export async function rejectPendingChange(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  const { reason } = z.object({ reason: z.string().min(3).max(500) }).parse(req.body);
  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
    select: { name: true },
  });
  const updated = await rejectChange(req.params.id, {
    userId: req.user.userId,
    name: user?.name ?? null,
    role: req.user.role,
  }, reason);
  res.json(updated);
}

/* ------------------------------------------------- master change history - */

const MASTER_ENTITIES: MasterEntity[] = ['PARTY', 'BROKER', 'TRANSPORT', 'COMPANY'];

/**
 * Field-level history for one master record (plan item 3.5).
 *
 * Account numbers are returned in full here, unlike in the alert emails: this
 * is behind the record's own view permission and is the screen someone uses to
 * check exactly what an account was changed from. Masking it would make the
 * history useless for the one job it has.
 */
export async function getMasterHistory(req: Request, res: Response) {
  const entity = String(req.params.entity ?? '').toUpperCase() as MasterEntity;
  if (!MASTER_ENTITIES.includes(entity)) throw new HttpError(404, 'No such record type');
  res.json(await historyFor(entity, req.params.id));
}
