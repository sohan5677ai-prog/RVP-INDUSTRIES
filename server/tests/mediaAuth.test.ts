/**
 * Integration tests for the weighbridge media gates (Phase 6b).
 *
 * Driven over HTTP so what is asserted is what a caller actually gets back.
 * No database: the gates reach the session lookup only when a Bearer token is
 * presented, and these tests present either a capability token, a bridge key,
 * or nothing at all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { requireMediaRead, requireMediaWrite } from '../src/middleware/mediaAuth.js';
import { errorHandler } from '../src/middleware/error.js';
import { mintMediaAccessToken } from '../src/lib/mediaAccessToken.js';

const ORIGINAL = { ...process.env };
const BRIDGE_KEY = 'b'.repeat(32);

beforeEach(() => {
  process.env.JWT_SECRET = 's'.repeat(40);
  process.env.CCTV_BRIDGE_KEY = BRIDGE_KEY;
  // Keep 500s terse if one ever happens, so a failure message stays readable.
  process.env.NODE_ENV = 'production';
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.get('/media/read', requireMediaRead, (_req, res) => res.json({ served: 'frame' }));
  app.post('/media/write', requireMediaWrite, (_req, res) => res.json({ accepted: true }));
  app.use(errorHandler);
  return app;
}

describe('requireMediaRead', () => {
  it('rejects an anonymous caller', async () => {
    // This is the hole being closed: before Phase 6b this returned a live
    // camera frame to anyone who knew the host.
    const res = await request(buildApp()).get('/media/read');
    expect(res.status).toBe(401);
    expect(res.body.served).toBeUndefined();
  });

  it('accepts a valid capability token in ?k=', async () => {
    const { token } = mintMediaAccessToken();
    const res = await request(buildApp()).get('/media/read').query({ k: token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ served: 'frame' });
  });

  it('accepts the cabin bridge key', async () => {
    const res = await request(buildApp())
      .get('/media/read')
      .set('x-cctv-bridge-key', BRIDGE_KEY);
    expect(res.status).toBe(200);
  });

  it('rejects a tampered, empty or wrong-secret token', async () => {
    const app = buildApp();
    const { token } = mintMediaAccessToken();
    const tampered = (token[0] === 'a' ? 'b' : 'a') + token.slice(1);

    expect((await request(app).get('/media/read').query({ k: tampered })).status).toBe(401);
    expect((await request(app).get('/media/read').query({ k: '' })).status).toBe(401);
    expect((await request(app).get('/media/read').query({ k: 'nonsense' })).status).toBe(401);
  });

  it('rejects a repeated ?k= that parses to an array', async () => {
    const { token } = mintMediaAccessToken();
    const res = await request(buildApp()).get(`/media/read?k=${token}&k=${token}`);
    expect(res.status).toBe(401);
  });

  it('rejects a wrong bridge key', async () => {
    const res = await request(buildApp())
      .get('/media/read')
      .set('x-cctv-bridge-key', 'c'.repeat(32));
    expect(res.status).toBe(401);
  });
});

describe('requireMediaWrite', () => {
  it('rejects an anonymous caller', async () => {
    // Before Phase 6b this accepted an arbitrary weight reading, or a serial
    // port reconfiguration, from anyone on the internet.
    const res = await request(buildApp()).post('/media/write').send({ liveWeight: 99999 });
    expect(res.status).toBe(401);
    expect(res.body.accepted).toBeUndefined();
  });

  it('accepts the cabin bridge key', async () => {
    const res = await request(buildApp())
      .post('/media/write')
      .set('x-cctv-bridge-key', BRIDGE_KEY)
      .send({ liveWeight: 1200 });
    expect(res.status).toBe(200);
  });

  it('refuses a capability token, however valid, and says why', async () => {
    // The central rule of the split: a token that travels in a URL - and so
    // into history, referrers and proxy logs - must never be able to change
    // the weight an operator sees.
    const { token } = mintMediaAccessToken();
    const res = await request(buildApp())
      .post('/media/write')
      .query({ k: token })
      .send({ liveWeight: 99999 });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/cannot authorise/i);
    expect(res.body.accepted).toBeUndefined();
  });
});
