import { describe, it, expect } from 'vitest';
import { Secret, TOTP } from 'otpauth';
import {
  RECOVERY_CODE_COUNT,
  generateMfaSecret,
  generateRecoveryCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  mfaEnrolmentUri,
  mfaRequiredFor,
  mintPasswordResetToken,
  hashPasswordResetToken,
  normaliseRecoveryCode,
  recoveryCodeMatches,
  verifyTotp,
} from './mfa.js';

/** Generate the code a real authenticator app would show at a given instant. */
function codeAt(secret: string, at: Date): string {
  return new TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  }).generate({ timestamp: at.getTime() });
}

describe('mfaRequiredFor', () => {
  it('requires MFA of the privileged roles', () => {
    expect(mfaRequiredFor('ADMIN')).toBe(true);
    expect(mfaRequiredFor('OWNER')).toBe(true);
    expect(mfaRequiredFor('DEVELOPER')).toBe(true);
  });

  it('does not require it of shop-floor USER accounts', () => {
    // Deliberate: shared cabin devices, not everyone has a smartphone, and
    // forcing it would produce one phone in a drawer - control in appearance
    // only. Revisited in Phase 2 as a permission check.
    expect(mfaRequiredFor('USER')).toBe(false);
  });
});

describe('secrets and enrolment', () => {
  it('generates a distinct base32 secret each time', () => {
    const a = generateMfaSecret();
    const b = generateMfaSecret();
    expect(a).toMatch(/^[A-Z2-7]+$/);
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(a).not.toBe(b);
  });

  it('builds an otpauth URI an authenticator app can scan', () => {
    const uri = mfaEnrolmentUri(generateMfaSecret(), 'sohan');
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('secret=');
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
    expect(decodeURIComponent(uri)).toContain('RVP Industries ERP');
  });
});

describe('verifyTotp', () => {
  const secret = generateMfaSecret();
  const at = new Date('2026-11-10T08:00:00.000Z');

  it('accepts the current code', () => {
    const result = verifyTotp(secret, codeAt(secret, at), at);
    expect(result.ok).toBe(true);
    expect(typeof result.step).toBe('number');
  });

  it('accepts a code one step either side, for clock drift', () => {
    const early = new Date(at.getTime() - 30_000);
    const late = new Date(at.getTime() + 30_000);
    expect(verifyTotp(secret, codeAt(secret, early), at).ok).toBe(true);
    expect(verifyTotp(secret, codeAt(secret, late), at).ok).toBe(true);
  });

  it('rejects a code from well outside the window', () => {
    const stale = new Date(at.getTime() - 10 * 60_000);
    expect(verifyTotp(secret, codeAt(secret, stale), at).ok).toBe(false);
  });

  it('reports the matched step, so a replay inside the window can be refused', () => {
    const code = codeAt(secret, at);
    const first = verifyTotp(secret, code, at);
    const second = verifyTotp(secret, code, at);
    expect(first.step).toBe(second.step);
  });

  it('tolerates spaces, as typed off a phone screen', () => {
    const code = codeAt(secret, at);
    expect(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, at).ok).toBe(true);
  });

  it('rejects malformed input without throwing', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34', '000000x']) {
      expect(verifyTotp(secret, bad, at).ok).toBe(false);
    }
  });

  it('rejects a code generated from a different secret', () => {
    expect(verifyTotp(secret, codeAt(generateMfaSecret(), at), at).ok).toBe(false);
  });
});

describe('recovery codes', () => {
  it('issues the expected number, all distinct', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
  });

  it('formats them in two readable groups', () => {
    expect(generateRecoveryCode()).toMatch(/^[ACDEFGHJKMNPQRTUVWXY34679]{5}-[ACDEFGHJKMNPQRTUVWXY34679]{5}$/);
  });

  it('avoids characters that are misread off paper', () => {
    const joined = generateRecoveryCodes(50).join('');
    // No 0/O, 1/I/L, 2/Z, 5/S, 8/B - a mistyped code must not become another
    // valid one.
    expect(joined).not.toMatch(/[01258BILOSZ]/);
  });

  it('normalises case and punctuation when matching', () => {
    const code = generateRecoveryCode();
    const hash = hashRecoveryCode(code);
    expect(recoveryCodeMatches(code.toLowerCase(), hash)).toBe(true);
    expect(recoveryCodeMatches(code.replace('-', ''), hash)).toBe(true);
    expect(recoveryCodeMatches(code.replace('-', ' '), hash)).toBe(true);
    expect(normaliseRecoveryCode('abcde-fghjk')).toBe('ABCDEFGHJK');
  });

  it('does not match a different code', () => {
    const hash = hashRecoveryCode(generateRecoveryCode());
    expect(recoveryCodeMatches(generateRecoveryCode(), hash)).toBe(false);
    expect(recoveryCodeMatches('', hash)).toBe(false);
  });

  it('stores a hash, not the code', () => {
    const code = generateRecoveryCode();
    const hash = hashRecoveryCode(code);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(normaliseRecoveryCode(code));
  });
});

describe('password reset tokens', () => {
  it('mints an opaque single-use token with a matching hash', () => {
    const { token, hash } = mintPasswordResetToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(hash).toBe(hashPasswordResetToken(token));
    expect(hash).not.toContain(token);
  });

  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 200 }, () => mintPasswordResetToken().token));
    expect(seen.size).toBe(200);
  });
});
