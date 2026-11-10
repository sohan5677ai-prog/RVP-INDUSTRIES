import { describe, it, expect } from 'vitest';
import {
  MIN_PASSWORD_LENGTH,
  validatePassword,
  isPasswordAcceptable,
} from './passwordPolicy.js';

const CTX = { username: 'sohan', name: 'Sohan Kumar', email: 'sohan@example.com' };

describe('length', () => {
  it('rejects anything under the minimum', () => {
    expect(validatePassword('short')).toContainEqual(
      expect.stringContaining(`at least ${MIN_PASSWORD_LENGTH}`)
    );
    // The old policy allowed 6 characters, which this must now reject.
    expect(isPasswordAcceptable('abc123')).toBe(false);
  });

  it('accepts a long passphrase', () => {
    expect(validatePassword('correct horse battery staple')).toEqual([]);
  });

  it('rejects an absurdly long one', () => {
    expect(validatePassword('x'.repeat(500))).toContainEqual(
      expect.stringContaining('at most')
    );
  });

  it('rejects leading or trailing whitespace', () => {
    // Almost always a paste accident, and impossible to diagnose from the
    // sign-in failure that follows.
    expect(validatePassword('  a good long passphrase  ')).toContainEqual(
      expect.stringContaining('spaces at the start or end')
    );
  });
});

describe('blocklist', () => {
  it('rejects a common password padded to the minimum length', () => {
    expect(isPasswordAcceptable('password1234')).toBe(false);
    expect(isPasswordAcceptable('monkey123456')).toBe(false);
    expect(isPasswordAcceptable('iloveyou1234')).toBe(false);
  });

  it('sees through leet substitution', () => {
    // The whole point of normalising: P@ssw0rd!! must not sneak past a
    // literal blocklist lookup.
    expect(isPasswordAcceptable('P@ssw0rd!!!!')).toBe(false);
    expect(isPasswordAcceptable('Adm1n1strat0r')).toBe(false);
  });

  it('rejects business-context guesses an insider would try', () => {
    expect(isPasswordAcceptable('tamarind2026')).toBe(false);
    expect(isPasswordAcceptable('weighbridge1')).toBe(false);
  });

  it('rejects repeated characters and straight sequences', () => {
    expect(isPasswordAcceptable('aaaaaaaaaaaa')).toBe(false);
    expect(isPasswordAcceptable('abcdefghijkl')).toBe(false);
    expect(isPasswordAcceptable('lkjihgfedcba')).toBe(false);
  });

  it('does not reject a strong password that merely contains a common word', () => {
    // "monkey" appears, but this is not a blocklist entry and has real entropy.
    expect(validatePassword('monkey-rides-a-purple-bicycle')).toEqual([]);
  });
});

describe('personal information', () => {
  it('rejects a password containing the username, name or email local part', () => {
    expect(validatePassword('sohan-is-my-name', CTX)).toContainEqual(
      expect.stringContaining('name, username or email')
    );
    expect(validatePassword('KumarKumarKumar', CTX)).toContainEqual(
      expect.stringContaining('name, username or email')
    );
  });

  it('rejects the company and product name', () => {
    expect(validatePassword('rvp-industries-2026')).toContainEqual(
      expect.stringContaining('company or product name')
    );
  });

  it('ignores context fields too short to be meaningful', () => {
    // A two-letter name must not blocklist every password containing it.
    expect(validatePassword('a splendid long passphrase', { username: 'jo' })).toEqual([]);
  });

  it('applies no personal check when no context is given', () => {
    expect(validatePassword('sohan-is-my-name')).toEqual([]);
  });
});

describe('reporting', () => {
  it('returns every problem at once rather than the first', () => {
    // Short, blocklisted and contains the username: all three should surface
    // so the user fixes them in one attempt.
    const problems = validatePassword('sohan1', { username: 'sohan' });
    expect(problems.length).toBeGreaterThanOrEqual(2);
  });
});
