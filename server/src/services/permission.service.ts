import type { Role } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import {
  defaultPermissionsFor,
  isPermission,
  type Permission,
} from '../lib/permissions.js';

/**
 * Resolving which permissions a role holds.
 *
 * Checked on every authorised request, so it is cached in process and
 * invalidated explicitly when the grants change. The cache is per-instance and
 * Render may run more than one, so a grant edit can take up to CACHE_TTL_MS to
 * reach every instance — acceptable for a settings change, and the TTL keeps
 * the worst case bounded without needing a shared cache.
 */

const CACHE_TTL_MS = 60 * 1000;
/** Shorter, so a transient database problem is retried reasonably soon. */
const FALLBACK_CACHE_TTL_MS = 10 * 1000;

interface CacheEntry {
  permissions: ReadonlySet<Permission>;
  /** True when these came from the database rather than the code defaults. */
  customised: boolean;
  expiresAt: number;
}

const cache = new Map<Role, CacheEntry>();

/** Drop the cache after an edit, so the change is visible on this instance at once. */
export function invalidatePermissionCache(role?: Role): void {
  if (role) cache.delete(role);
  else cache.clear();
}

/**
 * The permissions a role holds.
 *
 * Rows in RolePermission are authoritative *when present*: a role that has
 * been customised holds exactly what the database says, not the defaults plus
 * an overlay. Unknown permission strings are dropped rather than trusted, so a
 * typo in a row grants nothing instead of something unintended.
 *
 * On a database error this returns the code defaults rather than an empty set.
 * Failing closed here would lock the entire company out of the ERP because a
 * settings table was briefly unreachable; the defaults are a known-safe
 * position, and authentication — which does fail closed — has already run.
 */
export async function permissionsFor(role: Role): Promise<ReadonlySet<Permission>> {
  const now = Date.now();
  const hit = cache.get(role);
  if (hit && hit.expiresAt > now) return hit.permissions;

  try {
    const rows = await prisma.rolePermission.findMany({
      where: { role },
      select: { permission: true },
    });

    const permissions: ReadonlySet<Permission> =
      rows.length > 0
        ? new Set(rows.map((r) => r.permission).filter(isPermission))
        : defaultPermissionsFor(role);

    cache.set(role, { permissions, customised: rows.length > 0, expiresAt: now + CACHE_TTL_MS });
    return permissions;
  } catch (err) {
    logger.error(`permission lookup failed for role ${role}; using defaults`, err);
    const fallback = defaultPermissionsFor(role);
    // Cache the fallback too, briefly. Without this, a missing table or an
    // unreachable database means a failing query on every single request
    // across 415 routes - which is exactly the state between deploying this
    // code and applying the schema.
    cache.set(role, {
      permissions: fallback,
      customised: false,
      expiresAt: now + FALLBACK_CACHE_TTL_MS,
    });
    return fallback;
  }
}

export async function roleHasPermission(role: Role, permission: Permission): Promise<boolean> {
  return (await permissionsFor(role)).has(permission);
}

/**
 * Replace a role's permissions wholesale.
 *
 * A full replacement rather than add/remove calls, because the admin UI edits
 * a set of checkboxes and saves it: anything else leaves room for the stored
 * set and the screen to disagree.
 */
export async function setRolePermissions(
  role: Role,
  permissions: string[],
  actorUserId?: string
): Promise<ReadonlySet<Permission>> {
  const valid = permissions.filter(isPermission);

  await prisma.$transaction([
    prisma.rolePermission.deleteMany({ where: { role } }),
    prisma.rolePermission.createMany({
      data: valid.map((permission) => ({ role, permission, createdBy: actorUserId ?? null })),
      skipDuplicates: true,
    }),
  ]);

  invalidatePermissionCache(role);
  return new Set(valid);
}

/** Put a role back on the code defaults by removing its rows. */
export async function resetRolePermissions(role: Role): Promise<void> {
  await prisma.rolePermission.deleteMany({ where: { role } });
  invalidatePermissionCache(role);
}

/** Whether a role is running on customised grants or the code defaults. */
export async function roleIsCustomised(role: Role): Promise<boolean> {
  const now = Date.now();
  const hit = cache.get(role);
  if (hit && hit.expiresAt > now) return hit.customised;
  await permissionsFor(role);
  return cache.get(role)?.customised ?? false;
}

/**
 * Record a denial. Never throws: a failure to write the audit row must not
 * turn into a 500, and in audit mode must not interfere with the request it is
 * only observing.
 */
export async function recordDenial(params: {
  userId?: string;
  username?: string;
  role: Role;
  permission: string;
  method: string;
  path: string;
  enforced: boolean;
}): Promise<void> {
  try {
    await prisma.permissionDenial.create({
      data: {
        userId: params.userId ?? null,
        username: params.username ?? null,
        role: params.role,
        permission: params.permission,
        method: params.method.slice(0, 10),
        path: params.path.slice(0, 255),
        enforced: params.enforced,
      },
    });
  } catch (err) {
    logger.error('failed to record permission denial', err);
  }
}
