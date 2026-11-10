import type { PrismaClient, User } from '@prisma/client';
import { PasswordAlgo } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { HttpError } from '../lib/httpError.js';
import { hashPassword, verifyPassword } from '../lib/passwordHash.js';
import {
  PASSWORD_HISTORY_DEPTH,
  validatePassword,
  type PolicyContext,
} from '../lib/passwordPolicy.js';
import {
  absoluteExpiryFrom,
  mintRefreshToken,
  signAccessToken,
  type AccessTokenPayload,
} from '../lib/tokens.js';
import { SERVICE_SESSION_ID } from '../lib/sessionPolicy.js';
import { forgetSession, touchSession } from '../middleware/auth.js';

/**
 * Shared identity operations: issuing sessions, changing passwords, and the
 * revocation that has to go with both.
 *
 * Kept out of the controller because every one of these has to happen in more
 * than one place — a password is set at login (rehash), by the owner, by an
 * admin and by a reset link, and each must prune history and revoke sessions
 * identically. Duplicating that across four call sites is how one of them ends
 * up forgetting to revoke.
 */

/** Issue an access/refresh pair and attach them to a session row. */
export async function issueSessionTokens(params: {
  user: Pick<User, 'id' | 'role' | 'passwordChangedAt'>;
  sessionId: string;
  mfaSatisfied: boolean;
  /** Fresh sign-in starts the 12-hour clock; a refresh keeps the original. */
  absoluteExpiresAt?: Date | null;
  now?: Date;
}): Promise<{ accessToken: string; refreshToken: string; absoluteExpiresAt: Date }> {
  const now = params.now ?? new Date();
  const absoluteExpiresAt = params.absoluteExpiresAt ?? absoluteExpiryFrom(now);
  const refresh = mintRefreshToken();

  const session = await prisma.userSession.update({
    where: { id: params.sessionId },
    data: {
      refreshTokenHash: refresh.hash,
      absoluteExpiresAt,
      lastSeenAt: now,
    },
    select: { id: true, lastSeenAt: true },
  });
  touchSession(session.id, session.lastSeenAt);

  const payload: AccessTokenPayload = {
    userId: params.user.id,
    role: params.user.role,
    sid: params.sessionId,
    pwdAt: params.user.passwordChangedAt.getTime(),
    mfa: params.mfaSatisfied,
  };

  return { accessToken: signAccessToken(payload), refreshToken: refresh.token, absoluteExpiresAt };
}

/**
 * Check a candidate password against the policy and the user's own history.
 *
 * History is compared by verifying against each stored hash rather than by
 * hashing the candidate and comparing strings — the hashes are salted, so the
 * same password produces a different hash every time and string comparison
 * would never match.
 */
export async function assertPasswordAcceptable(params: {
  userId: string;
  plain: string;
  ctx: PolicyContext;
  /** The hash currently in use, checked as part of the history. */
  currentHash?: string;
}): Promise<void> {
  const problems = validatePassword(params.plain, params.ctx);
  if (problems.length > 0) {
    throw new HttpError(400, problems.join(' '));
  }

  const history = await prisma.passwordHistory.findMany({
    where: { userId: params.userId },
    orderBy: { createdAt: 'desc' },
    take: PASSWORD_HISTORY_DEPTH,
    select: { hash: true },
  });

  const candidates = params.currentHash
    ? [params.currentHash, ...history.map((h) => h.hash)]
    : history.map((h) => h.hash);

  for (const hash of candidates) {
    if ((await verifyPassword(params.plain, hash)).ok) {
      throw new HttpError(
        400,
        `That is one of your last ${PASSWORD_HISTORY_DEPTH} passwords. Choose one you have not used before.`
      );
    }
  }
}

/**
 * Set a new password: hash it, record the old one in history, prune history,
 * stamp passwordChangedAt, and revoke every other session.
 *
 * `passwordChangedAt` is what invalidates tokens issued earlier, so it must be
 * written in the same transaction as the hash — a crash between the two would
 * otherwise leave a changed password with every old token still valid.
 */
export async function setPassword(params: {
  userId: string;
  newPlain: string;
  /** Session to keep alive (the one performing the change). Null revokes all. */
  keepSessionId: string | null;
  /** True when an admin set it, forcing a change at next sign-in. */
  mustChangeNext?: boolean;
  now?: Date;
}): Promise<void> {
  const now = params.now ?? new Date();
  const newHash = await hashPassword(params.newPlain);

  const existing = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { password: true, passwordAlgo: true },
  });

  await prisma.$transaction(async (tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]) => {
    if (existing?.password) {
      await tx.passwordHistory.create({
        data: { userId: params.userId, hash: existing.password, algo: existing.passwordAlgo },
      });
      // Keep only the most recent DEPTH entries; the rest are dead weight and
      // every retained hash is one more thing to leak.
      const stale = await tx.passwordHistory.findMany({
        where: { userId: params.userId },
        orderBy: { createdAt: 'desc' },
        skip: PASSWORD_HISTORY_DEPTH,
        select: { id: true },
      });
      if (stale.length > 0) {
        await tx.passwordHistory.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
      }
    }

    await tx.user.update({
      where: { id: params.userId },
      data: {
        password: newHash,
        passwordAlgo: PasswordAlgo.ARGON2ID,
        passwordChangedAt: now,
        mustChangePassword: params.mustChangeNext ?? false,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });

    // Plan item 1.5: invalidate all sessions on password change. The access
    // tokens are already dead via the passwordChangedAt check; removing the
    // rows kills the refresh tokens too, so they cannot be exchanged.
    await tx.userSession.deleteMany({
      where: {
        userId: params.userId,
        ...(params.keepSessionId ? { id: { not: params.keepSessionId } } : {}),
      },
    });

    // Any outstanding reset link is spent, whichever path set the password.
    await tx.passwordResetToken.updateMany({
      where: { userId: params.userId, usedAt: null },
      data: { usedAt: now },
    });
  });
}

/**
 * Upgrade a verified bcrypt hash to argon2id in place.
 *
 * Deliberately does NOT touch passwordChangedAt: the password itself has not
 * changed, and bumping it would sign the user out of their other devices for
 * doing nothing but logging in.
 */
export async function upgradePasswordHash(userId: string, plain: string): Promise<void> {
  try {
    await prisma.user.update({
      where: { id: userId },
      data: { password: await hashPassword(plain), passwordAlgo: PasswordAlgo.ARGON2ID },
    });
  } catch (err) {
    // A failed upgrade must never fail the login that triggered it; the old
    // hash still verifies and the next sign-in will try again.
    logger.error('password hash upgrade failed', err);
  }
}

/** Revoke every session for a user, optionally sparing one. */
export async function revokeSessions(
  userId: string,
  keepSessionId: string | null = null
): Promise<void> {
  const doomed = await prisma.userSession.findMany({
    where: { userId, ...(keepSessionId ? { id: { not: keepSessionId } } : {}) },
    select: { id: true },
  });
  await prisma.userSession.deleteMany({ where: { id: { in: doomed.map((d) => d.id) } } });
  for (const d of doomed) forgetSession(d.id);
}

/** True for a sid that belongs to a machine principal rather than a browser. */
export function isServiceSession(sid: string | undefined): boolean {
  return sid === SERVICE_SESSION_ID;
}
