import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mintMediaAccessToken,
  isValidMediaAccessToken,
  mediaAccessTokenFromQuery,
} from './mediaAccessToken.js';
import { HttpError } from './httpError.js';

const WINDOW_MS = 6 * 60 * 60 * 1000;
const ORIGINAL = { ...process.env };

/** A fixed instant well inside a window, so tests are not boundary-sensitive. */
const T0 = 20_000 * WINDOW_MS + 1234;

beforeEach(() => {
  process.env.JWT_SECRET = 's'.repeat(40);
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('mintMediaAccessToken', () => {
  it('returns a hex token and an expiry', () => {
    const { token, expiresAt } = mintMediaAccessToken(T0);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresAt).toBeGreaterThan(T0);
  });

  it('is stable within a window and changes across one', () => {
    const a = mintMediaAccessToken(T0).token;
    const b = mintMediaAccessToken(T0 + WINDOW_MS / 2).token;
    const c = mintMediaAccessToken(T0 + WINDOW_MS).token;
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });

  it('is bound to the JWT secret, so rotating it invalidates tokens', () => {
    const before = mintMediaAccessToken(T0).token;
    process.env.JWT_SECRET = 'different-secret-that-is-long-enough';
    expect(mintMediaAccessToken(T0).token).not.toBe(before);
  });

  it('refuses to mint without a usable secret', () => {
    delete process.env.JWT_SECRET;
    expect(() => mintMediaAccessToken(T0)).toThrow(HttpError);
    process.env.JWT_SECRET = 'tooshort';
    expect(() => mintMediaAccessToken(T0)).toThrow(HttpError);
  });
});

describe('isValidMediaAccessToken', () => {
  it('accepts a token minted in the current window', () => {
    const { token } = mintMediaAccessToken(T0);
    expect(isValidMediaAccessToken(token, T0)).toBe(true);
  });

  it('still accepts it one window later, so an open screen keeps working', () => {
    const { token } = mintMediaAccessToken(T0);
    expect(isValidMediaAccessToken(token, T0 + WINDOW_MS)).toBe(true);
  });

  it('rejects it two windows later', () => {
    const { token } = mintMediaAccessToken(T0);
    expect(isValidMediaAccessToken(token, T0 + 2 * WINDOW_MS)).toBe(false);
  });

  it('stops accepting it at the stated expiry', () => {
    const { token, expiresAt } = mintMediaAccessToken(T0);
    expect(isValidMediaAccessToken(token, expiresAt - 1)).toBe(true);
    expect(isValidMediaAccessToken(token, expiresAt)).toBe(false);
  });

  it('rejects a token from the future', () => {
    const { token } = mintMediaAccessToken(T0 + 5 * WINDOW_MS);
    expect(isValidMediaAccessToken(token, T0)).toBe(false);
  });

  it('rejects missing, empty, malformed and tampered tokens', () => {
    const { token } = mintMediaAccessToken(T0);
    expect(isValidMediaAccessToken(undefined, T0)).toBe(false);
    expect(isValidMediaAccessToken('', T0)).toBe(false);
    expect(isValidMediaAccessToken('not-a-token', T0)).toBe(false);
    // Same length, one character different.
    const tampered = (token[0] === 'a' ? 'b' : 'a') + token.slice(1);
    expect(isValidMediaAccessToken(tampered, T0)).toBe(false);
    // A prefix of a valid token.
    expect(isValidMediaAccessToken(token.slice(0, 32), T0)).toBe(false);
  });

  it('rejects a token minted under a different secret', () => {
    const { token } = mintMediaAccessToken(T0);
    process.env.JWT_SECRET = 'a-completely-different-long-secret';
    expect(isValidMediaAccessToken(token, T0)).toBe(false);
  });
});

describe('mediaAccessTokenFromQuery', () => {
  it('reads k from a query object', () => {
    expect(mediaAccessTokenFromQuery({ k: 'abc' })).toBe('abc');
  });

  it('ignores anything that is not a non-empty string', () => {
    expect(mediaAccessTokenFromQuery({})).toBeUndefined();
    expect(mediaAccessTokenFromQuery({ k: '' })).toBeUndefined();
    // Express parses a repeated ?k= into an array; that must not be trusted.
    expect(mediaAccessTokenFromQuery({ k: ['a', 'b'] })).toBeUndefined();
    expect(mediaAccessTokenFromQuery({ k: 1 })).toBeUndefined();
    expect(mediaAccessTokenFromQuery(undefined)).toBeUndefined();
    expect(mediaAccessTokenFromQuery(null)).toBeUndefined();
    expect(mediaAccessTokenFromQuery('k=abc')).toBeUndefined();
  });
});
