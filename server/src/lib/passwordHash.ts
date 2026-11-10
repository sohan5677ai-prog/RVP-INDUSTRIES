import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import bcrypt from 'bcryptjs';
import { PasswordAlgo } from '@prisma/client';

/**
 * Password hashing.
 *
 * Argon2id, per plan item 1.1. Existing accounts hold bcryptjs hashes at cost
 * 10, so both formats must verify, and a bcrypt hash is upgraded in place on
 * the owner's next successful login — nobody has to be told to change their
 * password for the stronger algorithm to take effect.
 *
 * The algorithm is decided by **sniffing the stored hash**, not by the
 * `passwordAlgo` column. Both formats are self-describing (`$2a$`/`$2b$` for
 * bcrypt, `$argon2id$` for argon2), so the column is a convenience for
 * reporting and a stale value in it cannot lock anyone out.
 */

/**
 * OWASP's recommended argon2id baseline: 19 MiB, 2 passes, 1 lane. Chosen over
 * a heavier setting because Render's starter instance has 512 MB and logins can
 * arrive together at shift change; memoryCost is per concurrent hash.
 */
const ARGON2_OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Identify a stored hash by its own prefix. */
export function algoOf(storedHash: string): PasswordAlgo | null {
  if (storedHash.startsWith('$argon2id$')) return PasswordAlgo.ARGON2ID;
  if (/^\$2[aby]?\$/.test(storedHash)) return PasswordAlgo.BCRYPT;
  return null;
}

/** Hash a new password with the current algorithm. */
export async function hashPassword(plain: string): Promise<string> {
  return argonHash(plain, ARGON2_OPTIONS);
}

export interface VerifyResult {
  ok: boolean;
  /** True when the password was right but the hash is in a legacy format. */
  needsRehash: boolean;
}

/**
 * Verify a password against a stored hash of either format.
 *
 * Never throws for a bad password or an unrecognised hash — a malformed stored
 * value is a failed verification, not a 500, so one corrupt row cannot take
 * the login endpoint down.
 */
export async function verifyPassword(plain: string, storedHash: string): Promise<VerifyResult> {
  const algo = algoOf(storedHash);
  try {
    if (algo === PasswordAlgo.ARGON2ID) {
      return { ok: await argonVerify(storedHash, plain, ARGON2_OPTIONS), needsRehash: false };
    }
    if (algo === PasswordAlgo.BCRYPT) {
      const ok = await bcrypt.compare(plain, storedHash);
      return { ok, needsRehash: ok };
    }
  } catch {
    return { ok: false, needsRehash: false };
  }
  return { ok: false, needsRehash: false };
}

/**
 * A hash to compare against when the account does not exist, so the work done
 * — and therefore the response time — does not reveal whether a username is
 * real. Argon2id of a random string, generated once at module load.
 *
 * The existing code used a hardcoded bcrypt hash for this; with two algorithms
 * in play the dummy must be argon2, or an unknown username would be measurably
 * faster than a real one now that real hashes are argon2.
 */
let dummyHashPromise: Promise<string> | undefined;

export function dummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = argonHash(
      `no-such-account-${Math.random().toString(36)}`,
      ARGON2_OPTIONS
    );
  }
  return dummyHashPromise;
}

/**
 * Burn roughly the same CPU as a real verification, for a username that does
 * not exist. Awaited for its timing, not its result.
 */
export async function burnVerifyTime(plain: string): Promise<void> {
  try {
    await argonVerify(await dummyHash(), plain, ARGON2_OPTIONS);
  } catch {
    /* the result is irrelevant; the point is the elapsed time */
  }
}
