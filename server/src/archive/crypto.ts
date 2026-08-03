/**
 * Archive payload encryption: AES-256-GCM per entry, key derived from a
 * passphrase with scrypt.
 *
 * scrypt rather than Argon2id purely because it ships in node:crypto - an
 * archive format whose only dependency is the standard library is one fewer
 * thing that can fail to install on Render three years from now, when someone
 * needs to open FY 2025-26.
 *
 * Encrypting per entry (not the zip as a whole) keeps decryption streaming and
 * lets a reader pull one table without materialising the rest.
 */
import crypto from 'node:crypto';

export const KDF = { name: 'scrypt', N: 1 << 15, r: 8, p: 1, keyLen: 32 } as const;
export const CIPHER = 'aes-256-gcm';
export const IV_BYTES = 12;
export const SALT_BYTES = 16;

export function newSalt(): Buffer {
  return crypto.randomBytes(SALT_BYTES);
}

export function newIv(): Buffer {
  return crypto.randomBytes(IV_BYTES);
}

/**
 * Derives the archive key. Deliberately slow - `maxmem` has to be raised past
 * the 32 MB default because N=2^15 needs roughly 128*N*r = 32 MB plus overhead.
 */
export function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      passphrase.normalize('NFKC'),
      salt,
      KDF.keyLen,
      { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 256 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

/** A GCM cipher stream plus the IV it was seeded with. Tag is read after end. */
export function createEntryCipher(key: Buffer) {
  const iv = newIv();
  const cipher = crypto.createCipheriv(CIPHER, key, iv);
  return { iv, cipher };
}

/** A GCM decipher stream for one entry. Throws on `final()` if the tag fails. */
export function createEntryDecipher(key: Buffer, iv: Buffer, tag: Buffer) {
  const decipher = crypto.createDecipheriv(CIPHER, key, iv);
  decipher.setAuthTag(tag);
  return decipher;
}
