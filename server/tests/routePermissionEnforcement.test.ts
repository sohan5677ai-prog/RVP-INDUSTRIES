/**
 * Integration tests for the route permission middleware (Phase 2).
 *
 * The behaviour that matters most here is the difference between audit mode
 * and enforcement: audit mode must let the request through while recording the
 * denial, and enforcement must refuse. Getting that backwards would either
 * block the whole company on deploy, or quietly do nothing while appearing to
 * protect things.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const denialCreate = vi.fn().mockResolvedValue({});
const rolePermissionFindMany = vi.fn();

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    permissionDenial: { create: (...a: unknown[]) => denialCreate(...a) },
    rolePermission: { findMany: (...a: unknown[]) => rolePermissionFindMany(...a) },
  },
}));

const { enforceRoutePermissions } = await import('../src/middleware/routePermission.js');
const { errorHandler } = await import('../src/middleware/error.js');
const { invalidatePermissionCache } = await import('../src/services/permission.service.js');
const { SERVICE_SESSION_ID } = await import('../src/lib/sessionPolicy.js');

const ORIGINAL = { ...process.env };

/** An app that injects a given user, then runs the real middleware. */
function buildApp(user: Record<string, unknown> | null) {
  const app = express();
  app.use('/api', (req, _res, next) => {
    if (user) (req as unknown as { user: unknown }).user = user;
    next();
  });
  const router = express.Router();
  router.use(enforceRoutePermissions);
  router.all('/*', (_req, res) => res.json({ reached: true }));
  app.use('/api', router);
  app.use(errorHandler);
  return app;
}

const USER = { userId: 'u1', role: 'USER', sid: 'sess1', pwdAt: 0 };
const ADMIN = { userId: 'u2', role: 'ADMIN', sid: 'sess2', pwdAt: 0 };

beforeEach(() => {
  process.env.NODE_ENV = 'production';
  delete process.env.RBAC_ENFORCE;
  denialCreate.mockClear();
  // No rows => the code defaults apply.
  rolePermissionFindMany.mockReset().mockResolvedValue([]);
  invalidatePermissionCache();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.clearAllMocks();
});

describe('audit mode (the default)', () => {
  it('lets a request through even when the role lacks the permission', async () => {
    // USER has no payment.delete - before Phase 2 it could delete payments,
    // and audit mode must not break that until the mapping is proven.
    const res = await request(buildApp(USER)).delete('/api/payments/abc');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reached: true });
  });

  it('records the would-be denial with enforced = false', async () => {
    await request(buildApp(USER)).delete('/api/payments/abc');
    // Fire-and-forget, so give the microtask a turn.
    await new Promise((r) => setImmediate(r));
    expect(denialCreate).toHaveBeenCalledOnce();
    const data = denialCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({
      userId: 'u1',
      role: 'USER',
      permission: 'payment.delete',
      method: 'DELETE',
      enforced: false,
    });
    expect(data.path).toContain('/payments/abc');
  });

  it('records a route with no rule at all, so holes in the table surface', async () => {
    await request(buildApp(USER)).get('/api/not-a-real-route');
    await new Promise((r) => setImmediate(r));
    expect(denialCreate.mock.calls[0][0].data.permission).toBe('(no rule)');
  });

  it('does not record anything when the permission is held', async () => {
    const res = await request(buildApp(USER)).get('/api/payments');
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(denialCreate).not.toHaveBeenCalled();
  });
});

describe('enforcing mode', () => {
  beforeEach(() => {
    process.env.RBAC_ENFORCE = 'true';
  });

  it('refuses a request the role lacks permission for', async () => {
    const res = await request(buildApp(USER)).delete('/api/payments/abc');
    expect(res.status).toBe(403);
    expect(res.body.reached).toBeUndefined();
    expect(res.body.error).toMatch(/permission/i);
  });

  it('records the denial with enforced = true', async () => {
    await request(buildApp(USER)).delete('/api/payments/abc');
    await new Promise((r) => setImmediate(r));
    expect(denialCreate.mock.calls[0][0].data.enforced).toBe(true);
  });

  it('still allows what the role does hold', async () => {
    expect((await request(buildApp(USER)).get('/api/payments')).status).toBe(200);
    expect((await request(buildApp(USER)).post('/api/payments')).status).toBe(200);
  });

  it('denies an unmapped route by default', async () => {
    const res = await request(buildApp(USER)).get('/api/not-a-real-route');
    expect(res.status).toBe(403);
  });

  it('lets an ADMIN do what USER cannot', async () => {
    expect((await request(buildApp(ADMIN)).delete('/api/payments/abc')).status).toBe(200);
    expect((await request(buildApp(ADMIN)).get('/api/users')).status).toBe(200);
  });

  it('blocks the things the audit called out by name', async () => {
    const app = buildApp(USER);
    // The H4 examples: a shop-floor account could do all of these.
    expect((await request(app).delete('/api/payments/abc')).status).toBe(403);
    expect((await request(app).delete('/api/receipts/abc')).status).toBe(403);
    expect((await request(app).delete('/api/purchases/abc')).status).toBe(403);
    expect((await request(app).get('/api/users')).status).toBe(403);
    expect((await request(app).put('/api/settings/company')).status).toBe(403);
  });
});

describe('principals outside the role model', () => {
  beforeEach(() => {
    process.env.RBAC_ENFORCE = 'true';
  });

  it('lets a service token straight through', async () => {
    // The Slack bot and the kata cabin hold no role in the permission sense;
    // the cabin is confined to the weighbridge by its own scope check.
    const service = { ...USER, sid: SERVICE_SESSION_ID };
    expect((await request(buildApp(service)).delete('/api/payments/abc')).status).toBe(200);
    expect(rolePermissionFindMany).not.toHaveBeenCalled();
  });

  it('401s when there is no user at all', async () => {
    expect((await request(buildApp(null)).get('/api/payments')).status).toBe(401);
  });
});

describe('database-backed grants', () => {
  beforeEach(() => {
    process.env.RBAC_ENFORCE = 'true';
  });

  it('uses stored rows in place of the defaults when any exist', async () => {
    // Grant USER exactly one permission; everything else must now be refused,
    // including things the code default would have allowed.
    rolePermissionFindMany.mockResolvedValue([{ permission: 'payment.view' }]);
    invalidatePermissionCache();
    const app = buildApp(USER);
    expect((await request(app).get('/api/payments')).status).toBe(200);
    expect((await request(app).get('/api/parties')).status).toBe(403);
  });

  it('ignores permission strings that are not in the catalogue', async () => {
    rolePermissionFindMany.mockResolvedValue([
      { permission: 'payment.view' },
      { permission: 'not.a.real.permission' },
    ]);
    invalidatePermissionCache();
    expect((await request(buildApp(USER)).get('/api/payments')).status).toBe(200);
  });

  it('falls back to the defaults if the lookup fails, rather than locking everyone out', async () => {
    rolePermissionFindMany.mockRejectedValue(new Error('database unreachable'));
    invalidatePermissionCache();
    // USER holds payment.view by default, so normal work continues.
    expect((await request(buildApp(USER)).get('/api/payments')).status).toBe(200);
    // ...but it is still the defaults, not a free pass.
    expect((await request(buildApp(USER)).delete('/api/payments/abc')).status).toBe(403);
  });
});
