/**
 * Integration tests for the HTTP security layer (Phase 6a).
 *
 * These exercise the real middleware over a real HTTP server via supertest,
 * rather than calling the functions directly — the point is to check what a
 * client actually receives, including the headers and the response body.
 *
 * Deliberately no database: the middleware under test (cors, helmet, the error
 * handler) touches none, so these run anywhere, which is what makes them a
 * usable harness for the later phases.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import request from 'supertest';
import { errorHandler } from '../src/middleware/error.js';
import { isOriginAllowed, originPolicyFromEnv } from '../src/lib/corsOrigin.js';
import { HttpError } from '../src/lib/httpError.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

/**
 * An app wired the way src/index.ts wires the real one, with routes that fail
 * in each of the ways the error handler distinguishes.
 */
function buildApp() {
  const policy = originPolicyFromEnv();
  const app = express();
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (isOriginAllowed(origin, policy)) return cb(null, true);
        cb(null, false);
      },
    })
  );
  app.get('/ok', (_req, res) => res.json({ ok: true }));
  app.get('/boom', () => {
    throw new Error('Prisma connection string postgres://user:hunter2@db:5432 failed');
  });
  app.get('/teapot', () => {
    throw new HttpError(418, 'I am a teapot');
  });
  app.use(errorHandler);
  return app;
}

describe('error responses', () => {
  describe('in production', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('returns a generic message with no detail for an unexpected error', async () => {
      const res = await request(buildApp()).get('/boom');
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Internal server error' });
    });

    it('leaks neither a stack trace nor the error text', async () => {
      const res = await request(buildApp()).get('/boom');
      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(/hunter2/);
      expect(body).not.toMatch(/postgres:\/\//);
      expect(body).not.toMatch(/\bat .*\.ts/);
      expect(res.body.stack).toBeUndefined();
      expect(res.body.message).toBeUndefined();
    });

    it('still returns the message of an intentional HttpError', async () => {
      const res = await request(buildApp()).get('/teapot');
      expect(res.status).toBe(418);
      expect(res.body).toEqual({ error: 'I am a teapot' });
    });
  });

  describe('outside production', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'development';
    });

    it('includes the message and stack, where they are useful', async () => {
      const res = await request(buildApp()).get('/boom');
      expect(res.status).toBe(500);
      expect(res.body.message).toMatch(/Prisma connection string/);
      expect(res.body.stack).toBeTruthy();
    });
  });
});

describe('CORS', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    process.env.CLIENT_ORIGIN = 'https://erp.rvpindustries.com';
  });

  it('allows the deployed client to read responses', async () => {
    const res = await request(buildApp())
      .get('/ok')
      .set('Origin', 'https://rvp-industries.vercel.app');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://rvp-industries.vercel.app');
  });

  it('allows a configured custom domain', async () => {
    const res = await request(buildApp())
      .get('/ok')
      .set('Origin', 'https://erp.rvpindustries.com');
    expect(res.headers['access-control-allow-origin']).toBe('https://erp.rvpindustries.com');
  });

  it('withholds the CORS header from a look-alike origin', async () => {
    const res = await request(buildApp())
      .get('/ok')
      .set('Origin', 'https://rvp-localhost.attacker.com');
    // The request is still served - CORS is enforced by the browser - but
    // without the header, so the attacker's page cannot read the response.
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('withholds it from an unrelated vercel.app deployment', async () => {
    const res = await request(buildApp())
      .get('/ok')
      .set('Origin', 'https://someone-elses-app.vercel.app');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects a disallowed origin on the preflight too', async () => {
    const res = await request(buildApp())
      .options('/ok')
      .set('Origin', 'https://someone-elses-app.vercel.app')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not turn a rejected origin into a 500', async () => {
    const res = await request(buildApp())
      .get('/ok')
      .set('Origin', 'https://someone-elses-app.vercel.app');
    expect(res.status).toBe(200);
  });

  it('still serves callers that send no Origin at all', async () => {
    // The Tally agent, the CCTV bridge, the Fast2SMS webhooks and uptime
    // monitors all arrive without one.
    const res = await request(buildApp()).get('/ok');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('security headers', () => {
  it('sets the helmet defaults, including HSTS and nosniff', async () => {
    const res = await request(buildApp()).get('/ok');
    expect(res.headers['strict-transport-security']).toBeTruthy();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeTruthy();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
