import { describe, it, expect } from 'vitest';
import bcrypt from 'bcryptjs';
import { PasswordAlgo } from '@prisma/client';
import {
  algoOf,
  hashPassword,
  verifyPassword,
  burnVerifyTime,
} from './passwordHash.js';

const PLAIN = 'a-perfectly-fine-passphrase';

describe('algoOf', () => {
  it('recognises argon2id and every bcrypt prefix variant', () => {
    expect(algoOf('$argon2id$v=19$m=19456,t=2,p=1$abc$def')).toBe(PasswordAlgo.ARGON2ID);
    expect(algoOf('$2a$10$abcdefghijklmnopqrstuv')).toBe(PasswordAlgo.BCRYPT);
    expect(algoOf('$2b$12$abcdefghijklmnopqrstuv')).toBe(PasswordAlgo.BCRYPT);
    expect(algoOf('$2y$12$abcdefghijklmnopqrstuv')).toBe(PasswordAlgo.BCRYPT);
  });

  it('returns null for anything else', () => {
    expect(algoOf('')).toBeNull();
    expect(algoOf('plaintext')).toBeNull();
    expect(algoOf('$argon2i$v=19$...')).toBeNull(); // argon2i, not argon2id
    expect(algoOf('$5$rounds=5000$sha-crypt')).toBeNull();
  });
});

describe('hashPassword', () => {
  it('produces an argon2id hash', async () => {
    const hash = await hashPassword(PLAIN);
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(algoOf(hash)).toBe(PasswordAlgo.ARGON2ID);
  });

  it('is salted, so the same password hashes differently each time', async () => {
    const [a, b] = await Promise.all([hashPassword(PLAIN), hashPassword(PLAIN)]);
    expect(a).not.toBe(b);
  });
});

describe('verifyPassword', () => {
  it('accepts the right argon2 password and asks for no rehash', async () => {
    const hash = await hashPassword(PLAIN);
    expect(await verifyPassword(PLAIN, hash)).toEqual({ ok: true, needsRehash: false });
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword(PLAIN);
    expect((await verifyPassword('not-it-at-all', hash)).ok).toBe(false);
  });

  // The upgrade path: existing accounts hold bcrypt hashes at cost 10.
  it('accepts a legacy bcrypt password and flags it for rehash', async () => {
    const legacy = await bcrypt.hash(PLAIN, 10);
    expect(await verifyPassword(PLAIN, legacy)).toEqual({ ok: true, needsRehash: true });
  });

  it('does not flag a rehash when the bcrypt password was wrong', async () => {
    const legacy = await bcrypt.hash(PLAIN, 10);
    expect(await verifyPassword('wrong', legacy)).toEqual({ ok: false, needsRehash: false });
  });

  it('treats a malformed or empty stored hash as a failure, not an error', async () => {
    // One corrupt row must not be able to 500 the login endpoint.
    for (const bad of ['', 'garbage', '$argon2id$truncated', '$2a$10$short']) {
      await expect(verifyPassword(PLAIN, bad)).resolves.toEqual({
        ok: false,
        needsRehash: false,
      });
    }
  });

  it('rejects an empty password against a real hash', async () => {
    const hash = await hashPassword(PLAIN);
    expect((await verifyPassword('', hash)).ok).toBe(false);
  });

  it('distinguishes passwords that differ only past 72 bytes', async () => {
    // bcrypt silently truncates at 72 bytes, so these two would collide under
    // the old scheme. argon2id does not truncate.
    const base = 'x'.repeat(72);
    const hash = await hashPassword(`${base}aaaa`);
    expect((await verifyPassword(`${base}aaaa`, hash)).ok).toBe(true);
    expect((await verifyPassword(`${base}bbbb`, hash)).ok).toBe(false);
  });
});

describe('burnVerifyTime', () => {
  it('resolves without throwing, so an unknown username costs the same work', async () => {
    await expect(burnVerifyTime('anything')).resolves.toBeUndefined();
  });
});
