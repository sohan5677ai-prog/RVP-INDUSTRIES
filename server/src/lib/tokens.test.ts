import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  ACCESS_TOKEN_TTL_MS,
  ABSOLUTE_SESSION_TTL_MS,
  absoluteExpiryFrom,
  hashRefreshToken,
  mintRefreshToken,
  refreshTokenMatches,
  signAccessToken,
  tokenPredatesPasswordChange,
  verifyAccessToken,
  type AccessTokenPayload,
} from './tokens.js';

const ORIGINAL = { ...process.env };

const PAYLOAD: AccessTokenPayload = {
  userId: 'u1',
  role: 'ADMIN',
  sid: 's1',
  pwdAt: 1_700_000_000_000,
};

beforeEach(() => {
  process.env.JWT_SECRET = 's'.repeat(40);
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('access tokens', () => {
  it('round-trips the payload', () => {
    const decoded = verifyAccessToken(signAccessToken(PAYLOAD));
    expect(decoded.userId).toBe('u1');
    expect(decoded.role).toBe('ADMIN');
    expect(decoded.sid).toBe('s1');
    expect(decoded.pwdAt).toBe(PAYLOAD.pwdAt);
  });

  it('expires in 15 minutes, not 7 days', () => {
    const decoded = jwt.decode(signAccessToken(PAYLOAD)) as { iat: number; exp: number };
    expect((decoded.exp - decoded.iat) * 1000).toBe(ACCESS_TOKEN_TTL_MS);
    expect(ACCESS_TOKEN_TTL_MS).toBe(15 * 60 * 1000);
  });

  it('refuses a token signed with a different secret', () => {
    const foreign = jwt.sign(PAYLOAD, 'a-different-secret-entirely');
    expect(() => verifyAccessToken(foreign)).toThrow();
  });

  it('refuses a tampered token', () => {
    const token = signAccessToken(PAYLOAD);
    const parts = token.split('.');
    const body = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    body.role = 'DEVELOPER';
    parts[1] = Buffer.from(JSON.stringify(body)).toString('base64url');
    expect(() => verifyAccessToken(parts.join('.'))).toThrow();
  });

  it('refuses an already-expired token', () => {
    const expired = jwt.sign(PAYLOAD, process.env.JWT_SECRET as string, { expiresIn: -10 });
    expect(() => verifyAccessToken(expired)).toThrow();
  });

  // The module caches the secret after first use - deliberately, matching the
  // existing jwt.ts, which means rotating JWT_SECRET needs a restart. So this
  // has to be checked against a freshly imported copy; asserting it after the
  // tests above would only prove the cache works.
  it('will not sign without a usable secret', async () => {
    vi.resetModules();
    delete process.env.JWT_SECRET;
    const fresh = await import('./tokens.js');
    expect(() => fresh.signAccessToken(PAYLOAD)).toThrow(/JWT_SECRET/);

    vi.resetModules();
    process.env.JWT_SECRET = 'short';
    const tooShort = await import('./tokens.js');
    expect(() => tooShort.signAccessToken(PAYLOAD)).toThrow(/JWT_SECRET/);
  });
});

describe('password-change invalidation', () => {
  // This is what makes a password change log out every other device at once,
  // rather than whenever the old tokens happen to expire.
  it('rejects a token issued before the password changed', () => {
    const changedAt = new Date(PAYLOAD.pwdAt + 60_000);
    expect(tokenPredatesPasswordChange(PAYLOAD, changedAt)).toBe(true);
  });

  it('accepts a token issued after the change', () => {
    const changedAt = new Date(PAYLOAD.pwdAt - 60_000);
    expect(tokenPredatesPasswordChange(PAYLOAD, changedAt)).toBe(false);
  });

  it('tolerates sub-second skew, so the token minted by the change itself survives', () => {
    // Postgres stores milliseconds; the JWT iat is whole seconds. Without the
    // slack, the token issued by a password change could be rejected by it.
    const changedAt = new Date(PAYLOAD.pwdAt + 400);
    expect(tokenPredatesPasswordChange(PAYLOAD, changedAt)).toBe(false);
  });
});

describe('refresh tokens', () => {
  it('mints an opaque token with a matching hash', () => {
    const { token, hash } = mintRefreshToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toContain('.'); // not a JWT; carries no claims
    expect(hash).toBe(hashRefreshToken(token));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 200 }, () => mintRefreshToken().token));
    expect(seen.size).toBe(200);
  });

  it('matches only the exact token', () => {
    const { token, hash } = mintRefreshToken();
    expect(refreshTokenMatches(token, hash)).toBe(true);
    expect(refreshTokenMatches(`${token}x`, hash)).toBe(false);
    expect(refreshTokenMatches(token.slice(0, -1), hash)).toBe(false);
    expect(refreshTokenMatches('', hash)).toBe(false);
    expect(refreshTokenMatches(token, mintRefreshToken().hash)).toBe(false);
  });

  it('does not leak the plaintext into the stored hash', () => {
    const { token, hash } = mintRefreshToken();
    expect(hash).not.toContain(token);
  });
});

describe('absolute session expiry', () => {
  it('caps a session at 12 hours regardless of activity', () => {
    const now = new Date('2026-11-10T08:00:00.000Z');
    expect(absoluteExpiryFrom(now).getTime() - now.getTime()).toBe(ABSOLUTE_SESSION_TTL_MS);
    expect(ABSOLUTE_SESSION_TTL_MS).toBe(12 * 60 * 60 * 1000);
  });
});
