import type { LoginOutcome } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';

/**
 * Account lockout and per-username throttling, per plan item 1.4.
 *
 * The existing `loginLimiter` caps attempts per IP. That alone does not stop
 * credential stuffing, which spreads one username across many addresses and so
 * never trips a per-IP bucket. These checks are keyed on the username instead,
 * and persist in the database rather than in one process's memory — Render can
 * run more than one instance, and an in-memory counter resets on every deploy.
 */

/** Consecutive failures before the account locks. */
export const MAX_FAILED_ATTEMPTS = Number(process.env.LOGIN_MAX_FAILED_ATTEMPTS ?? 5);
/** How long the lock lasts. */
export const LOCKOUT_MS =
  Number(process.env.LOGIN_LOCKOUT_MINUTES ?? 15) * 60 * 1000;
/** Window for the per-username attempt rate limit. */
const USERNAME_WINDOW_MS = 15 * 60 * 1000;
/** Failed attempts on one username within that window, across all IPs. */
const USERNAME_WINDOW_LIMIT = Number(process.env.LOGIN_USERNAME_WINDOW_LIMIT ?? 20);

/**
 * Record an attempt. Never throws: an audit write failing must not turn a
 * successful login into an error, and must not mask the real outcome.
 */
export async function recordLoginAttempt(params: {
  username: string;
  ip?: string | null;
  userAgent?: string | null;
  outcome: LoginOutcome;
}): Promise<void> {
  try {
    await prisma.loginAttempt.create({
      data: {
        username: params.username.slice(0, 128),
        ip: params.ip?.slice(0, 64) ?? null,
        userAgent: params.userAgent?.slice(0, 255) ?? null,
        outcome: params.outcome,
      },
    });
  } catch (err) {
    logger.error('failed to record login attempt', err);
  }
}

export interface LockState {
  locked: boolean;
  /** When the lock lifts, if locked. */
  until?: Date;
  /** Whole minutes remaining, for the message shown to the user. */
  minutesLeft?: number;
}

function describeLock(until: Date, now: Date): LockState {
  const minutesLeft = Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 60000));
  return { locked: true, until, minutesLeft };
}

/**
 * Is this account currently locked?
 *
 * Checked before the password is verified, so a locked account cannot be
 * probed for a correct password — and deliberately returns the same answer
 * whether the password offered was right or wrong.
 */
export function lockStateOf(
  user: { lockedUntil: Date | null },
  now: Date = new Date()
): LockState {
  if (user.lockedUntil && user.lockedUntil > now) return describeLock(user.lockedUntil, now);
  return { locked: false };
}

/**
 * Per-username flood check, independent of the lock. Catches an attacker
 * rotating IPs against one account, and also an account being hammered while
 * its lock has just expired.
 */
export async function isUsernameFlooded(
  username: string,
  now: Date = new Date()
): Promise<boolean> {
  try {
    const since = new Date(now.getTime() - USERNAME_WINDOW_MS);
    const failures = await prisma.loginAttempt.count({
      where: {
        username,
        createdAt: { gte: since },
        outcome: { in: ['BAD_PASSWORD', 'NO_SUCH_USER', 'MFA_FAILED', 'LOCKED_OUT'] },
      },
    });
    return failures >= USERNAME_WINDOW_LIMIT;
  } catch (err) {
    // Fail open rather than locking everyone out of the ERP because a count
    // query failed. The per-IP limiter and the lock counter both still apply.
    logger.error('username flood check failed', err);
    return false;
  }
}

/**
 * Note a failed attempt and lock the account if it has crossed the threshold.
 * Returns the resulting lock state so the caller can tell the user.
 */
export async function registerFailure(
  userId: string,
  now: Date = new Date()
): Promise<LockState> {
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { failedLoginCount: { increment: 1 } },
    select: { failedLoginCount: true },
  });

  if (updated.failedLoginCount < MAX_FAILED_ATTEMPTS) return { locked: false };

  const until = new Date(now.getTime() + LOCKOUT_MS);
  await prisma.user.update({
    where: { id: userId },
    // Counter resets with the lock, so the next lock needs another full run of
    // failures rather than a single one.
    data: { lockedUntil: until, failedLoginCount: 0 },
  });
  return describeLock(until, now);
}

/** Clear the failure counter and lock after a successful sign-in. */
export async function registerSuccess(userId: string, now: Date = new Date()): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now },
  });
}
