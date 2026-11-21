import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

/**
 * Encrypting a database dump at rest (Phase 9, plan item 1).
 *
 * A dump of this database holds every party's bank account and GSTIN, every
 * transaction, and every user's password hash. It is going to sit in a synced
 * cloud folder, so it is encrypted before it leaves this process - the folder's
 * own access control is someone else's software and not something to rely on
 * alone.
 *
 * AES-256-GCM, so the file is authenticated as well as encrypted: a dump that
 * has been corrupted in sync, or altered, fails to decrypt rather than
 * restoring quietly wrong data. For a backup that is the more valuable half -
 * silent corruption is the failure mode that destroys a restore when you
 * finally need one.
 *
 * File layout, written in this order:
 *
 *   magic    8 bytes   "RVPBAK01", so a stray file is recognisable
 *   salt    16 bytes   per-file, so two dumps never share a key stream
 *   iv      12 bytes   GCM nonce
 *   tag     16 bytes   GCM authentication tag
 *   body     n bytes   the ciphertext
 */

export const MAGIC = Buffer.from('RVPBAK01', 'utf8');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
export const HEADER_LEN = MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN;

/**
 * Turn the configured key into 32 bytes.
 *
 * The key is expected to be 64 hex characters. Anything else is hashed with
 * the per-file salt rather than rejected, so a human-chosen passphrase still
 * produces a valid key - but see `describeKeyStrength`, which is what tells
 * the operator their passphrase is weak instead of silently accepting it.
 */
export function deriveKey(secret: string, salt: Buffer): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(secret.trim())) {
    return Buffer.from(secret.trim(), 'hex');
  }
  return createHash('sha256').update(Buffer.concat([salt, Buffer.from(secret, 'utf8')])).digest();
}

export function describeKeyStrength(secret: string): 'strong' | 'weak' | 'missing' {
  const s = secret?.trim() ?? '';
  if (s === '') return 'missing';
  if (/^[0-9a-fA-F]{64}$/.test(s)) return 'strong';
  return 'weak';
}

/** A fresh 64-hex-character key, which is what the backup script suggests. */
export function generateKey(): string {
  return randomBytes(32).toString('hex');
}

export function encrypt(plaintext: Buffer, secret: string): Buffer {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret, salt), iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

export class BackupDecryptError extends Error {}

export function decrypt(file: Buffer, secret: string): Buffer {
  if (file.length < HEADER_LEN) {
    throw new BackupDecryptError('That file is too small to be a backup.');
  }
  if (!file.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new BackupDecryptError(
      'That file is not an RVP backup (wrong magic bytes). Check you picked the right file.'
    );
  }

  let o = MAGIC.length;
  const salt = file.subarray(o, (o += SALT_LEN));
  const iv = file.subarray(o, (o += IV_LEN));
  const tag = file.subarray(o, (o += TAG_LEN));
  const body = file.subarray(o);

  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret, salt), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    // GCM cannot tell "wrong key" from "altered file" - both fail the tag
    // check - so the message says both rather than guessing.
    throw new BackupDecryptError(
      'Could not decrypt. Either BACKUP_ENCRYPTION_KEY is not the key this file was written ' +
        'with, or the file has been altered or truncated in transit.'
    );
  }
}
