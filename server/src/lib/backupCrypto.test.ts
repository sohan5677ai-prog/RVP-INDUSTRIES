/**
 * Encrypting a database dump (Phase 9, plan item 1).
 *
 * The tests that matter for a backup are not that it encrypts - it is that it
 * REFUSES to hand back data it cannot vouch for. A backup that decrypts to
 * subtly wrong bytes is worse than one that fails loudly, because you only
 * find out at a restore, which is the worst possible moment.
 */
import { describe, it, expect } from 'vitest';
import {
  encrypt,
  decrypt,
  generateKey,
  deriveKey,
  describeKeyStrength,
  BackupDecryptError,
  MAGIC,
  HEADER_LEN,
} from './backupCrypto.js';

const KEY = generateKey();
const DUMP = Buffer.from('PGDMP fake custom-format dump with bank details and hashes');

describe('a round trip', () => {
  it('returns exactly what went in', () => {
    expect(decrypt(encrypt(DUMP, KEY), KEY).equals(DUMP)).toBe(true);
  });

  it('handles an empty payload and a large one', () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 7);
    expect(decrypt(encrypt(Buffer.alloc(0), KEY), KEY).length).toBe(0);
    expect(decrypt(encrypt(big, KEY), KEY).equals(big)).toBe(true);
  });

  it('produces a different file every time, even for the same input', () => {
    // Per-file salt and nonce: two nightly dumps of an idle database must not
    // be byte-identical, or they leak that nothing changed.
    const a = encrypt(DUMP, KEY);
    const b = encrypt(DUMP, KEY);
    expect(a.equals(b)).toBe(false);
    expect(decrypt(a, KEY).equals(decrypt(b, KEY))).toBe(true);
  });

  it('writes a recognisable header', () => {
    const out = encrypt(DUMP, KEY);
    expect(out.subarray(0, MAGIC.length).equals(MAGIC)).toBe(true);
    expect(out.length).toBe(HEADER_LEN + DUMP.length);
  });
});

describe('it refuses what it cannot vouch for', () => {
  it('rejects the wrong key', () => {
    expect(() => decrypt(encrypt(DUMP, KEY), generateKey())).toThrow(BackupDecryptError);
  });

  it('rejects a file altered anywhere in the body', () => {
    // The whole point of GCM over CBC here: silent corruption in a synced
    // folder must fail the restore, not produce plausible-looking rubbish.
    const out = encrypt(DUMP, KEY);
    out[out.length - 1] ^= 0xff;
    expect(() => decrypt(out, KEY)).toThrow(BackupDecryptError);
  });

  it('rejects a file altered in the nonce or the tag', () => {
    for (const offset of [MAGIC.length + 16, MAGIC.length + 16 + 12]) {
      const out = encrypt(DUMP, KEY);
      out[offset] ^= 0xff;
      expect(() => decrypt(out, KEY), `offset ${offset}`).toThrow(BackupDecryptError);
    }
  });

  it('rejects a truncated file rather than returning a partial dump', () => {
    const out = encrypt(DUMP, KEY);
    expect(() => decrypt(out.subarray(0, out.length - 5), KEY)).toThrow(BackupDecryptError);
    expect(() => decrypt(out.subarray(0, 10), KEY)).toThrow(/too small/i);
  });

  it('says plainly when the file is not a backup at all', () => {
    const notOurs = Buffer.concat([Buffer.from('ZIPFILE!'), Buffer.alloc(100)]);
    expect(() => decrypt(notOurs, KEY)).toThrow(/not an RVP backup/i);
  });
});

describe('the key', () => {
  it('generates 64 hex characters', () => {
    expect(generateKey()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('uses a hex key directly, and salts anything else', () => {
    const salt = Buffer.alloc(16, 1);
    expect(deriveKey(KEY, salt).toString('hex')).toBe(KEY);
    // A passphrase still works, but is salted per file rather than used raw.
    const other = Buffer.alloc(16, 2);
    expect(deriveKey('a passphrase', salt).equals(deriveKey('a passphrase', other))).toBe(false);
  });

  it('tells the operator when the key is weak rather than failing silently', () => {
    expect(describeKeyStrength(KEY)).toBe('strong');
    expect(describeKeyStrength('mypassword')).toBe('weak');
    expect(describeKeyStrength('')).toBe('missing');
    expect(describeKeyStrength('   ')).toBe('missing');
  });

  it('a passphrase still round-trips, since refusing it outright would push people to no backup', () => {
    expect(decrypt(encrypt(DUMP, 'a long enough passphrase'), 'a long enough passphrase').equals(DUMP)).toBe(true);
  });
});
