import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Request } from 'express';
import { createHmac } from 'node:crypto';
import { getExpectedBridgeKey, isTrustedCameraBridge } from './cameraBridgeKey.js';
import { HttpError } from './httpError.js';

/** Minimal Request stand-in: the module only reads one header. */
function reqWithKey(key?: string): Request {
  return {
    header: (name: string) =>
      name.toLowerCase() === 'x-cctv-bridge-key' ? key : undefined,
  } as unknown as Request;
}

const ORIGINAL = { ...process.env };

beforeEach(() => {
  delete process.env.CCTV_BRIDGE_KEY;
  delete process.env.JWT_SECRET;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('getExpectedBridgeKey', () => {
  it('prefers an explicitly configured key', () => {
    process.env.CCTV_BRIDGE_KEY = 'x'.repeat(32);
    expect(getExpectedBridgeKey()).toBe('x'.repeat(32));
  });

  it('ignores a configured key that is too short to be real', () => {
    process.env.CCTV_BRIDGE_KEY = 'short';
    process.env.JWT_SECRET = 'y'.repeat(32);
    expect(getExpectedBridgeKey()).not.toBe('short');
  });

  it('derives from JWT_SECRET when no bridge key is set', () => {
    process.env.JWT_SECRET = 'y'.repeat(32);
    const expected = createHmac('sha256', 'y'.repeat(32))
      .update('rvp-cctv-bridge-v1')
      .digest('hex');
    expect(getExpectedBridgeKey()).toBe(expected);
  });

  // The whole point of the change: there is no hardcoded fallback secret any
  // more, so an unconfigured server cannot be opened with a key from the repo.
  it('throws rather than falling back to a literal when nothing is configured', () => {
    expect(() => getExpectedBridgeKey()).toThrow(HttpError);
    expect(() => getExpectedBridgeKey()).toThrow(/not configured/i);
  });

  it('throws on a JWT secret too short to be trustworthy', () => {
    process.env.JWT_SECRET = 'tooshort';
    expect(() => getExpectedBridgeKey()).toThrow(HttpError);
  });

  it('is not satisfied by the old hardcoded default', () => {
    process.env.JWT_SECRET = 'y'.repeat(32);
    const legacy = createHmac('sha256', 'rvp-default-kata-secret-key-2026')
      .update('rvp-cctv-bridge-v1')
      .digest('hex');
    expect(isTrustedCameraBridge(reqWithKey(legacy))).toBe(false);
  });
});

describe('isTrustedCameraBridge', () => {
  beforeEach(() => {
    process.env.CCTV_BRIDGE_KEY = 'k'.repeat(32);
  });

  it('accepts the configured key', () => {
    expect(isTrustedCameraBridge(reqWithKey('k'.repeat(32)))).toBe(true);
  });

  it('rejects a wrong key of the same length', () => {
    expect(isTrustedCameraBridge(reqWithKey('j'.repeat(32)))).toBe(false);
  });

  it('rejects a key that is a prefix of the real one', () => {
    expect(isTrustedCameraBridge(reqWithKey('k'.repeat(24)))).toBe(false);
  });

  it('rejects a missing or trivially short key without touching config', () => {
    delete process.env.CCTV_BRIDGE_KEY;
    delete process.env.JWT_SECRET;
    // No throw: a caller presenting no key is "not the bridge", not a 500.
    expect(isTrustedCameraBridge(reqWithKey(undefined))).toBe(false);
    expect(isTrustedCameraBridge(reqWithKey(''))).toBe(false);
    expect(isTrustedCameraBridge(reqWithKey('short'))).toBe(false);
  });
});
