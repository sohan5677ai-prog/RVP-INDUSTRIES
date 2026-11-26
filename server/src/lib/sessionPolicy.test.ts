import { describe, expect, it } from 'vitest';
import { IDLE_TIMEOUT_MS, SESSION_GRACE_MS, sessionIsIdleExpired } from './sessionPolicy.js';
import { TRUSTED_SESSION_TTL_MS, absoluteExpiryFrom } from './tokens.js';

describe('remembered devices', () => {
  const now = new Date('2026-11-26T10:00:00Z');
  const longAgo = new Date(now.getTime() - IDLE_TIMEOUT_MS - SESSION_GRACE_MS - 1000);

  it('an ordinary session dies after the idle window', () => {
    expect(sessionIsIdleExpired({ lastSeenAt: longAgo, trustedAt: null }, now)).toBe(true);
    expect(sessionIsIdleExpired({ lastSeenAt: now, trustedAt: null }, now)).toBe(false);
  });

  it('a remembered session is exempt from the idle window', () => {
    expect(sessionIsIdleExpired({ lastSeenAt: longAgo, trustedAt: longAgo }, now)).toBe(false);
  });

  it('a remembered session is capped at 30 days', () => {
    expect(absoluteExpiryFrom(now, true).getTime() - now.getTime()).toBe(TRUSTED_SESSION_TTL_MS);
    expect(TRUSTED_SESSION_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});
