/**
 * Integration tests for requireAuth (Phase 1).
 *
 * Driven over HTTP, with Prisma mocked so no database is needed. What matters
 * here is the set of reasons a previously-valid token stops working, because
 * before Phase 1 there was only one — expiry after seven days.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const sessionFindUnique = vi.fn();
const sessionUpdate = vi.fn();
const sessionDeleteMany = vi.fn();

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    userSession: {
      findUnique: (...a: unknown[]) => sessionFindUnique(...a),
      update: (...a: unknown[]) => sessionUpdate(...a),
      deleteMany: (...a: unknown[]) => sessionDeleteMany(...a),
    },
  },
}));

const { requireAuth, forgetSession } = await import('../src/middleware/auth.js');
const { signAccessToken, signServiceToken } = await import('../src/lib/tokens.js');
const { errorHandler } = await import('../src/middleware/error.js');
const { SERVICE_SESSION_ID } = await import('../src/lib/sessionPolicy.js');

const ORIGINAL = { ...process.env };
const PWD_AT = Date.parse('2026-11-01T00:00:00.000Z');

function buildApp() {
  const app = express();
  app.get('/protected', requireAuth, (req, res) => res.json({ role: req.user?.role }));
  app.use(errorHandler);
  return app;
}

/** A live session whose user is in good standing. */
function healthySession(over: Record<string, unknown> = {}) {
  return {
    id: 'sess_1',
    lastSeenAt: new Date(),
    absoluteExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    user: {
      passwordChangedAt: new Date(PWD_AT),
      disabledAt: null,
      role: 'USER',
      mustChangePassword: false,
    },
    ...over,
  };
}

function tokenFor(over: Record<string, unknown> = {}) {
  return signAccessToken({
    userId: 'u1',
    role: 'ADMIN',
    sid: 'sess_1',
    pwdAt: PWD_AT,
    ...over,
  } as Parameters<typeof signAccessToken>[0]);
}

beforeEach(() => {
  process.env.JWT_SECRET = 's'.repeat(40);
  process.env.NODE_ENV = 'production';
  sessionFindUnique.mockReset();
  sessionUpdate.mockReset().mockResolvedValue({});
  sessionDeleteMany.mockReset().mockResolvedValue({ count: 1 });
  // The 30-second lastSeen cache would short-circuit the DB checks between
  // tests that reuse the same sid.
  forgetSession('sess_1');
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.clearAllMocks();
});

describe('rejects the obvious', () => {
  it('401s with no header, a bare token, or a malformed scheme', async () => {
    const app = buildApp();
    expect((await request(app).get('/protected')).status).toBe(401);
    expect((await request(app).get('/protected').set('Authorization', 'abc')).status).toBe(401);
    expect((await request(app).get('/protected').set('Authorization', 'Basic abc')).status).toBe(401);
  });

  it('401s on a token signed with another secret', async () => {
    const foreign = (await import('jsonwebtoken')).default.sign(
      { userId: 'u1', role: 'ADMIN', sid: 'sess_1', pwdAt: PWD_AT },
      'some-other-secret-entirely'
    );
    const res = await request(buildApp()).get('/protected').set('Authorization', `Bearer ${foreign}`);
    expect(res.status).toBe(401);
  });
});

describe('a valid token on a live session', () => {
  it('passes and refreshes lastSeenAt', async () => {
    sessionFindUnique.mockResolvedValue(healthySession());
    const res = await request(buildApp())
      .get('/protected')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(sessionUpdate).toHaveBeenCalledOnce();
  });

  it('takes the role from the database, not the token', async () => {
    // A demotion must bite immediately; the token still claims ADMIN.
    sessionFindUnique.mockResolvedValue(healthySession());
    const res = await request(buildApp())
      .get('/protected')
      .set('Authorization', `Bearer ${tokenFor({ role: 'ADMIN' })}`);
    expect(res.body.role).toBe('USER');
  });
});

describe('the reasons a valid token stops working', () => {
  it('401s when the session row is gone', async () => {
    sessionFindUnique.mockResolvedValue(null);
    const res = await request(buildApp())
      .get('/protected')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Session ended/i);
  });

  // Plan item 1.5. This is the behaviour that did not exist before Phase 1.
  it('401s and kills the session when the password changed after the token was issued', async () => {
    sessionFindUnique.mockResolvedValue(
      healthySession({
        user: {
          passwordChangedAt: new Date(PWD_AT + 60_000),
          disabledAt: null,
          role: 'USER',
          mustChangePassword: false,
        },
      })
    );
    const res = await request(buildApp())
      .get('/protected')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/password was changed/i);
    expect(sessionDeleteMany).toHaveBeenCalled();
  });

  it('accepts a token issued in the same second as the password change', async () => {
    // Postgres keeps milliseconds, the JWT iat does not; without the slack the
    // token minted *by* a password change would be rejected by it.
    sessionFindUnique.mockResolvedValue(
      healthySession({
        user: {
          passwordChangedAt: new Date(PWD_AT + 400),
          disabledAt: null,
          role: 'USER',
          mustChangePassword: false,
        },
      })
    );
    const res = await request(buildApp())
      .get('/protected')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
  });

  it('401s and kills the session for a disabled account', async () => {
    sessionFindUnique.mockResolvedValue(
      healthySession({
        user: {
          passwordChangedAt: new Date(PWD_AT),
          disabledAt: new Date(),
          role: 'USER',
          mustChangePassword: false,
        },
      })
    );
    const res = await request(buildApp())
      .get('/protected')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/disabled/i);
    expect(sessionDeleteMany).toHaveBeenCalled();
  });

  it('401s past the absolute session cap, however recent the activity', async () => {
    sessionFindUnique.mockResolvedValue(
      healthySession({
        lastSeenAt: new Date(),
        absoluteExpiresAt: new Date(Date.now() - 1000),
      })
    );
    const res = await request(buildApp())
      .get('/protected')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Session expired/i);
  });

  it('401s on an idle session', async () => {
    sessionFindUnique.mockResolvedValue(
      healthySession({ lastSeenAt: new Date(Date.now() - 60 * 60 * 1000) })
    );
    const res = await request(buildApp())
      .get('/protected')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/inactivity/i);
  });
});

describe('service tokens', () => {
  it('skip the session lookup entirely', async () => {
    // The Slack bot and the cabin screen have no UserSession row, no idle
    // timeout and no password to have changed.
    const token = signServiceToken({
      userId: 'u1',
      role: 'USER',
      sid: SERVICE_SESSION_ID,
      scope: 'KATA_CABIN',
    });
    const res = await request(buildApp()).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(sessionFindUnique).not.toHaveBeenCalled();
  });

  it('401s a token with no sid at all', async () => {
    const legacy = (await import('jsonwebtoken')).default.sign(
      { userId: 'u1', role: 'ADMIN', pwdAt: PWD_AT },
      process.env.JWT_SECRET as string
    );
    const res = await request(buildApp()).get('/protected').set('Authorization', `Bearer ${legacy}`);
    expect(res.status).toBe(401);
  });
});
