/**
 * The archive manifest: the only file that stays plaintext when the payload is
 * encrypted, because the Archive Manager page has to identify a dropped file
 * before it can ask for the passphrase. It therefore carries metadata only - no
 * party names, no GSTINs, no per-voucher amounts.
 */
import crypto from 'node:crypto';
import { canonicalJson } from './serialize.js';
import { KDF, CIPHER } from './crypto.js';

export const ARCHIVE_FORMAT = 'rvparchive';
export const FORMAT_VERSION = 1;

/**
 * Bumped whenever the Prisma schema changes in a way that alters archive
 * content. The mount pipeline refuses an archive it has no transform chain for,
 * rather than guessing.
 */
export const SCHEMA_VERSION = 17;

export interface ManifestEntry {
  model: string;
  /** Rows in this file. */
  rows: number;
  /** NDJSON bytes before compression or encryption. */
  plainBytes: number;
  /** SHA-256 of the STORED bytes, so integrity is checkable before decrypting. */
  sha256: string;
  /** GCM parameters, present only when the archive is encrypted. */
  iv?: string;
  tag?: string;
}

export interface Manifest {
  format: typeof ARCHIVE_FORMAT;
  formatVersion: number;
  schemaVersion: number;
  erpCommit: string | null;
  company: { name: string; gstin: string | null };
  financialYear: { fyStart: number; label: string; from: string; to: string };
  exportedAt: string;
  exportedAtIst: string;
  exportedBy: { userId: string; username: string };
  encryption:
    | { enabled: false }
    | {
        enabled: true;
        cipher: string;
        kdf: typeof KDF.name;
        N: number;
        r: number;
        p: number;
        salt: string;
      };
  entries: Record<string, ManifestEntry>;
  totals: {
    /** Σ JournalLine.debit for the year, as a string. Must equal credit. */
    trialBalanceDr: string;
    trialBalanceCr: string;
    rows: number;
  };
  /** SHA-256 of this manifest with `seal` removed. Set by `sealManifest`. */
  seal?: string;
}

/** Canonical bytes a seal is computed over: the manifest minus the seal itself. */
function sealableJson(manifest: Manifest): string {
  const { seal: _seal, ...rest } = manifest;
  return canonicalJson(rest);
}

/**
 * Stamps the manifest with a hash of its own canonical form, so it cannot be
 * edited to match a tampered payload without also forging the seal.
 */
export function sealManifest(manifest: Manifest): Manifest {
  const seal = crypto.createHash('sha256').update(sealableJson(manifest), 'utf8').digest('hex');
  return { ...manifest, seal };
}

/** True when the manifest's seal matches its contents. */
export function verifySeal(manifest: Manifest): boolean {
  if (!manifest.seal) return false;
  const expected = crypto
    .createHash('sha256')
    .update(sealableJson(manifest), 'utf8')
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(manifest.seal, 'hex'),
  );
}

export function encryptionBlock(salt: Buffer | null): Manifest['encryption'] {
  if (!salt) return { enabled: false };
  return {
    enabled: true,
    cipher: CIPHER,
    kdf: KDF.name,
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    salt: salt.toString('base64'),
  };
}
