import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { timingSafeEqual } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { getKataCabinAccessKey } from '../lib/jwt.js';
import { HttpError } from '../lib/httpError.js';
import { logger } from '../lib/logger.js';
import {
  loginSchema,
  mfaChallengeSchema,
  refreshSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  mfaConfirmSchema,
  mfaDisableSchema,
} from '../schemas/auth.schema.js';
import {
  MAX_DEVICES_PER_USER,
  SERVICE_SESSION_ID,
  liveSessionCutoff,
} from '../lib/sessionPolicy.js';
import { forgetSession, touchSession } from '../middleware/auth.js';
import {
  getMaintenanceConfigRecord,
  isMaintenanceActive,
  formatMaintenanceStatus,
} from '../services/maintenance.service.js';
import { burnVerifyTime, verifyPassword } from '../lib/passwordHash.js';
import {
  isUsernameFlooded,
  lockStateOf,
  recordLoginAttempt,
  registerFailure,
  registerSuccess,
} from '../lib/loginGuard.js';
import { isIpAllowedForRole, normaliseIp } from '../lib/ipAllowList.js';
import {
  generateMfaSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  mfaEnrolmentUri,
  mfaRequiredFor,
  mintPasswordResetToken,
  hashPasswordResetToken,
  recoveryCodeMatches,
  verifyTotp,
  PASSWORD_RESET_TTL_MS,
} from '../lib/mfa.js';
import {
  refreshTokenMatches,
  signServiceToken,
  absoluteExpiryFrom,
} from '../lib/tokens.js';
import {
  assertPasswordAcceptable,
  issueSessionTokens,
  revokeSessions,
  setPassword,
  upgradePasswordHash,
} from '../services/identity.service.js';
import {
  sendNewDeviceAlert,
  sendPasswordResetEmail,
} from '../services/securityMail.service.js';

/**
 * Authentication.
 *
 * The order of checks in `login` is deliberate and worth not rearranging:
 * lockout and the flood check come *before* the password is verified, so a
 * locked account cannot be used as an oracle to test passwords; and the
 * response for an unknown username is identical, in both wording and timing,
 * to the response for a wrong password.
 */

function keysMatch(received: string | undefined, expected: string | undefined): boolean {
  if (!received || !expected || expected.length < 24) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The one message every failed credential check returns. */
const INVALID_CREDENTIALS = 'Invalid credentials';

function clientIp(req: Request): string | null {
  return normaliseIp(req.ip) ?? null;
}

function clientUserAgent(req: Request): string | null {
  return req.headers['user-agent']?.slice(0, 255) ?? null;
}

/**
 * MFA is enforced only when MFA_ENFORCE is on.
 *
 * Default off, on purpose. Turning this on before the privileged accounts have
 * enrolled would lock every administrator out of the ERP with no way back in
 * except a database edit. So it ships inert: enrol, confirm it works, then set
 * MFA_ENFORCE=true. Same approach as the report-only CSP in Phase 6b.
 */
function mfaEnforced(): boolean {
  return process.env.MFA_ENFORCE === 'true';
}

interface SessionUser {
  id: string;
  name: string;
  username: string;
  role: 'ADMIN' | 'USER' | 'OWNER' | 'DEVELOPER';
  email: string | null;
  mustChangePassword: boolean;
  mfaEnrolled: boolean;
  mfaEnrolmentRequired: boolean;
}

function shapeUser(u: {
  id: string;
  name: string;
  username: string;
  role: SessionUser['role'];
  email: string | null;
  mustChangePassword: boolean;
  mfaEnabledAt: Date | null;
}): SessionUser {
  return {
    id: u.id,
    name: u.name,
    username: u.username,
    role: u.role,
    email: u.email,
    mustChangePassword: u.mustChangePassword,
    mfaEnrolled: !!u.mfaEnabledAt,
    mfaEnrolmentRequired: mfaRequiredFor(u.role) && !u.mfaEnabledAt,
  };
}

/* ------------------------------------------------------------------- login */

export async function login(req: Request, res: Response) {
  const { username, password, deviceId, remember } = loginSchema.parse(req.body);
  const ip = clientIp(req);
  const userAgent = clientUserAgent(req);
  const attempt = { username, ip, userAgent };

  const user = await prisma.user.findUnique({ where: { username } });

  if (!user) {
    // Same work, same wording, same timing as a wrong password.
    await burnVerifyTime(password);
    await recordLoginAttempt({ ...attempt, outcome: 'NO_SUCH_USER' });
    throw new HttpError(401, INVALID_CREDENTIALS);
  }

  if (user.disabledAt) {
    await recordLoginAttempt({ ...attempt, outcome: 'DISABLED' });
    throw new HttpError(403, 'This account has been disabled.');
  }

  // Before the password check, so a locked account is not a password oracle.
  const lock = lockStateOf(user);
  if (lock.locked) {
    await recordLoginAttempt({ ...attempt, outcome: 'LOCKED_OUT' });
    throw new HttpError(
      429,
      `Too many failed attempts. Try again in ${lock.minutesLeft} minute${
        lock.minutesLeft === 1 ? '' : 's'
      }.`
    );
  }

  if (await isUsernameFlooded(username)) {
    await recordLoginAttempt({ ...attempt, outcome: 'LOCKED_OUT' });
    throw new HttpError(429, 'Too many attempts on this account. Try again shortly.');
  }

  const { ok, needsRehash } = await verifyPassword(password, user.password);
  if (!ok) {
    const nowLocked = await registerFailure(user.id);
    await recordLoginAttempt({ ...attempt, outcome: 'BAD_PASSWORD' });
    if (nowLocked.locked) {
      throw new HttpError(
        429,
        `Too many failed attempts. This account is locked for ${nowLocked.minutesLeft} minutes.`
      );
    }
    throw new HttpError(401, INVALID_CREDENTIALS);
  }

  if (!(await isIpAllowedForRole(user.role, req.ip))) {
    await recordLoginAttempt({ ...attempt, outcome: 'IP_NOT_ALLOWED' });
    throw new HttpError(403, 'Sign-in from this network is not permitted for your role.');
  }

  if (user.role !== 'DEVELOPER') {
    const config = await getMaintenanceConfigRecord();
    if (isMaintenanceActive(config)) {
      const status = formatMaintenanceStatus(config);
      const minsLeft = Math.ceil(status.secondsLeft / 60);
      const timeMsg = minsLeft > 0 ? ` (approx. ${minsLeft} min${minsLeft === 1 ? '' : 's'} remaining)` : '';
      throw new HttpError(503, `System is currently under maintenance${timeMsg}: ${status.message}`);
    }
  }

  // The password was right but is stored under the old algorithm. Upgrade it
  // now, before anything can fail, and without touching passwordChangedAt.
  if (needsRehash) await upgradePasswordHash(user.id, password);

  // MFA: hand back a challenge rather than a session.
  if (user.mfaEnabledAt && mfaEnforced()) {
    await recordLoginAttempt({ ...attempt, outcome: 'MFA_REQUIRED' });
    return res.json({
      mfaRequired: true,
      challenge: signMfaChallenge(user.id, deviceId),
    });
  }

  const issued = await establishSession({ user, deviceId, ip, userAgent, remember, mfaSatisfied: false });
  await recordLoginAttempt({ ...attempt, outcome: 'SUCCESS' });
  res.json(issued);
}

/* ----------------------------------------------------------- MFA challenge */

/**
 * A signed, short-lived note saying "this user proved their password just now".
 *
 * Deliberately not a session: it cannot be used as a bearer token anywhere,
 * because it carries no `sid` and the auth middleware would reject it. Two
 * minutes is enough to read a code off a phone and no longer.
 */
function signMfaChallenge(userId: string, deviceId: string): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new HttpError(500, 'JWT_SECRET is not configured');
  return jwt.sign({ mfa: userId, dev: deviceId }, secret, { expiresIn: '2m' });
}

function readMfaChallenge(token: string): { userId: string; deviceId: string } {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new HttpError(500, 'JWT_SECRET is not configured');
  try {
    const decoded = jwt.verify(token, secret) as { mfa?: string; dev?: string };
    if (!decoded.mfa || !decoded.dev) throw new Error('malformed');
    return { userId: decoded.mfa, deviceId: decoded.dev };
  } catch {
    throw new HttpError(401, 'That sign-in attempt expired. Please start again.');
  }
}

export async function verifyMfa(req: Request, res: Response) {
  const input = mfaChallengeSchema.parse(req.body);
  const { userId, deviceId } = readMfaChallenge(input.challenge);
  if (deviceId !== input.deviceId) {
    throw new HttpError(401, 'That sign-in attempt expired. Please start again.');
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.mfaSecret || user.disabledAt) {
    throw new HttpError(401, 'That sign-in attempt expired. Please start again.');
  }

  const ip = clientIp(req);
  const userAgent = clientUserAgent(req);
  const attempt = { username: user.username, ip, userAgent };

  let satisfied = false;

  if (input.code) {
    satisfied = verifyTotp(user.mfaSecret, input.code).ok;
  }

  if (!satisfied && input.recoveryCode) {
    // A recovery code is single-use: find an unused one that matches, then
    // spend it in the same breath.
    const codes = await prisma.mfaRecoveryCode.findMany({
      where: { userId: user.id, usedAt: null },
      select: { id: true, codeHash: true },
    });
    const match = codes.find((c) => recoveryCodeMatches(input.recoveryCode as string, c.codeHash));
    if (match) {
      const spent = await prisma.mfaRecoveryCode.updateMany({
        where: { id: match.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      // updateMany's count guards against two requests spending the same code.
      satisfied = spent.count === 1;
    }
  }

  if (!satisfied) {
    await registerFailure(user.id);
    await recordLoginAttempt({ ...attempt, outcome: 'MFA_FAILED' });
    throw new HttpError(401, 'That code was not correct.');
  }

  const issued = await establishSession({
    user,
    deviceId,
    ip,
    userAgent,
    remember: input.remember,
    mfaSatisfied: true,
  });
  await recordLoginAttempt({ ...attempt, outcome: 'SUCCESS' });
  res.json(issued);
}

/* --------------------------------------------------------- session issuing */

async function establishSession(params: {
  user: {
    id: string;
    name: string;
    username: string;
    role: SessionUser['role'];
    email: string | null;
    mustChangePassword: boolean;
    mfaEnabledAt: Date | null;
    passwordChangedAt: Date;
  };
  deviceId: string;
  ip: string | null;
  userAgent: string | null;
  remember?: boolean;
  mfaSatisfied: boolean;
}) {
  const { user, deviceId, ip, userAgent } = params;
  const now = new Date();

  // Sessions that have gone quiet past the idle window are dead - drop them so
  // a closed laptop or a lost phone stops holding one of the device slots.
  await prisma.userSession.deleteMany({
    where: { userId: user.id, lastSeenAt: { lt: liveSessionCutoff(now) } },
  });

  const existing = await prisma.userSession.findUnique({
    where: { userId_deviceId: { userId: user.id, deviceId } },
  });

  // A developer account is support staff and has to be able to sign in from
  // wherever the problem is; every other role is capped.
  if (!existing && user.role !== 'DEVELOPER') {
    const live = await prisma.userSession.count({ where: { userId: user.id } });
    if (live >= MAX_DEVICES_PER_USER) {
      await recordLoginAttempt({
        username: user.username,
        ip,
        userAgent,
        outcome: 'DEVICE_LIMIT',
      });
      throw new HttpError(
        403,
        `This account is already signed in on ${MAX_DEVICES_PER_USER} devices. Sign out on one of them, or leave it idle for a few minutes, then try again.`
      );
    }
  }

  const isNewDevice = !existing;

  const session = existing
    ? await prisma.userSession.update({
        where: { id: existing.id },
        data: {
          lastSeenAt: now,
          userAgent,
          ip,
          ...(params.remember ? { trustedAt: existing.trustedAt ?? now } : {}),
        },
      })
    : await prisma.userSession.create({
        data: {
          userId: user.id,
          deviceId,
          userAgent,
          ip,
          absoluteExpiresAt: absoluteExpiryFrom(now),
          ...(params.remember ? { trustedAt: now } : {}),
        },
      });

  touchSession(session.id, session.lastSeenAt);

  const tokens = await issueSessionTokens({
    user,
    sessionId: session.id,
    mfaSatisfied: params.mfaSatisfied,
    // A fresh sign-in restarts the 12-hour clock; signing in again on a device
    // that already has a live session does not extend it beyond its original
    // cap unless this is a new session row.
    absoluteExpiresAt: existing?.absoluteExpiresAt ?? absoluteExpiryFrom(now),
    now,
  });

  await registerSuccess(user.id, now);

  // Plan item 1.6. Fire-and-forget: an alert is a notification about a login,
  // not a part of it. Suppressed for a device the user has chosen to trust.
  if (isNewDevice && user.email && !params.remember) {
    void sendNewDeviceAlert({
      to: user.email,
      name: user.name,
      username: user.username,
      ip,
      userAgent,
      at: now,
    });
  }

  return {
    token: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.absoluteExpiresAt.toISOString(),
    user: shapeUser(user),
  };
}

/* ----------------------------------------------------------------- refresh */

export async function refresh(req: Request, res: Response) {
  const { refreshToken, deviceId } = refreshSchema.parse(req.body);

  const session = await prisma.userSession.findFirst({
    where: { deviceId, refreshTokenHash: { not: null } },
    include: { user: true },
  });
  if (!session?.refreshTokenHash) {
    throw new HttpError(401, 'Session ended. Please sign in again.');
  }

  if (!refreshTokenMatches(refreshToken, session.refreshTokenHash)) {
    // A refresh token that does not match the stored hash, on a session that
    // has one, means an already-rotated token was replayed. Either it leaked
    // or two clients are racing; the safe reading is theft, so the session
    // dies rather than being re-issued.
    logger.warn(`refresh token reuse detected for session ${session.id}; revoking`);
    await prisma.userSession.deleteMany({ where: { id: session.id } });
    forgetSession(session.id);
    throw new HttpError(401, 'Session ended. Please sign in again.');
  }

  const now = new Date();
  if (session.user.disabledAt) {
    await prisma.userSession.deleteMany({ where: { id: session.id } });
    forgetSession(session.id);
    throw new HttpError(401, 'This account has been disabled.');
  }
  if (session.absoluteExpiresAt && session.absoluteExpiresAt <= now) {
    await prisma.userSession.deleteMany({ where: { id: session.id } });
    forgetSession(session.id);
    throw new HttpError(401, 'Session expired. Please sign in again.');
  }
  if (session.lastSeenAt < liveSessionCutoff(now)) {
    await prisma.userSession.deleteMany({ where: { id: session.id } });
    forgetSession(session.id);
    throw new HttpError(401, 'Signed out after a period of inactivity. Please sign in again.');
  }

  const tokens = await issueSessionTokens({
    user: session.user,
    sessionId: session.id,
    mfaSatisfied: true,
    absoluteExpiresAt: session.absoluteExpiresAt,
    now,
  });

  res.json({
    token: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.absoluteExpiresAt.toISOString(),
    user: shapeUser(session.user),
  });
}

/* --------------------------------------------------------------- passwords */

export async function changePassword(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);

  const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
  if (!user) throw new HttpError(404, 'User not found');

  const { ok } = await verifyPassword(currentPassword, user.password);
  if (!ok) throw new HttpError(401, 'Your current password is not correct.');

  await assertPasswordAcceptable({
    userId: user.id,
    plain: newPassword,
    ctx: { username: user.username, name: user.name, email: user.email },
    currentHash: user.password,
  });

  // Keeps the session doing the changing, kills every other one.
  await setPassword({
    userId: user.id,
    newPlain: newPassword,
    keepSessionId: req.user.sid === SERVICE_SESSION_ID ? null : req.user.sid,
  });

  // The caller's own access token carries the old pwdAt and is now stale, so
  // hand back a fresh pair rather than making them sign in again.
  const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  const tokens = await issueSessionTokens({
    user: updated,
    sessionId: req.user.sid,
    mfaSatisfied: req.user.mfa ?? false,
  });

  res.json({
    token: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.absoluteExpiresAt.toISOString(),
    user: shapeUser(updated),
  });
}

/**
 * Plan item 1.8. Always answers the same way, whether or not the address is
 * one we know - the response must not be an account-existence oracle.
 */
export async function forgotPassword(req: Request, res: Response) {
  const { email } = forgotPasswordSchema.parse(req.body);
  const sameAnswer = {
    ok: true,
    message: 'If that email address has an account, a reset link is on its way.',
  };

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.disabledAt) return res.json(sameAnswer);

  const { token, hash } = mintPasswordResetToken();
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

  // Any earlier outstanding link is spent, so only the newest one works.
  await prisma.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  await prisma.passwordResetToken.create({
    data: { userId: user.id, tokenHash: hash, expiresAt, requestIp: clientIp(req) },
  });

  await sendPasswordResetEmail({
    to: email,
    name: user.name,
    token,
    expiresAt,
    requestIp: clientIp(req),
  });

  res.json(sameAnswer);
}

export async function resetPassword(req: Request, res: Response) {
  const { token, newPassword } = resetPasswordSchema.parse(req.body);

  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashPasswordResetToken(token) },
    include: { user: true },
  });

  const now = new Date();
  if (!record || record.usedAt || record.expiresAt <= now || record.user.disabledAt) {
    throw new HttpError(400, 'That reset link has expired or already been used.');
  }

  await assertPasswordAcceptable({
    userId: record.userId,
    plain: newPassword,
    ctx: {
      username: record.user.username,
      name: record.user.name,
      email: record.user.email,
    },
    currentHash: record.user.password,
  });

  // Every session goes: whoever asked for this reset may be locking an intruder
  // out, and leaving their sessions alive would defeat the point.
  await setPassword({ userId: record.userId, newPlain: newPassword, keepSessionId: null });
  await prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: now } });

  res.json({ ok: true, message: 'Password changed. Please sign in.' });
}

/* --------------------------------------------------------------------- MFA */

export async function beginMfaEnrolment(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user.userId } });

  if (user.mfaEnabledAt) {
    throw new HttpError(400, 'Two-factor authentication is already set up on this account.');
  }

  // Stored unconfirmed. mfaEnabledAt stays null until a code verifies, so an
  // abandoned enrolment cannot lock the account.
  const secret = generateMfaSecret();
  await prisma.user.update({ where: { id: user.id }, data: { mfaSecret: secret } });

  res.json({ secret, otpauthUri: mfaEnrolmentUri(secret, user.username) });
}

export async function confirmMfaEnrolment(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  const { code } = mfaConfirmSchema.parse(req.body);

  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user.userId } });
  if (!user.mfaSecret) throw new HttpError(400, 'Start two-factor setup first.');
  if (user.mfaEnabledAt) throw new HttpError(400, 'Two-factor authentication is already set up.');

  if (!verifyTotp(user.mfaSecret, code).ok) {
    throw new HttpError(400, 'That code was not correct. Check the time on your phone and try again.');
  }

  // Recovery codes are shown exactly once, here. They are stored hashed, so
  // there is no way to show them again - which is the point.
  const codes = generateRecoveryCodes();
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { mfaEnabledAt: new Date() } }),
    prisma.mfaRecoveryCode.deleteMany({ where: { userId: user.id } }),
    prisma.mfaRecoveryCode.createMany({
      data: codes.map((c) => ({ userId: user.id, codeHash: hashRecoveryCode(c) })),
    }),
  ]);

  res.json({
    ok: true,
    recoveryCodes: codes,
    message:
      'Save these recovery codes somewhere safe and offline. Each works once, and they cannot be shown again.',
  });
}

export async function disableMfa(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  const { currentPassword, code } = mfaDisableSchema.parse(req.body);

  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user.userId } });
  if (!user.mfaEnabledAt || !user.mfaSecret) {
    throw new HttpError(400, 'Two-factor authentication is not set up on this account.');
  }
  if (mfaRequiredFor(user.role) && mfaEnforced()) {
    throw new HttpError(
      403,
      'Two-factor authentication is required for your role and cannot be switched off.'
    );
  }

  // Both factors to remove a factor: a live session alone is not enough.
  const { ok } = await verifyPassword(currentPassword, user.password);
  if (!ok) throw new HttpError(401, 'Your current password is not correct.');
  if (!verifyTotp(user.mfaSecret, code).ok) throw new HttpError(400, 'That code was not correct.');

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { mfaSecret: null, mfaEnabledAt: null },
    }),
    prisma.mfaRecoveryCode.deleteMany({ where: { userId: user.id } }),
  ]);

  res.json({ ok: true });
}

/* ------------------------------------------------------------------ kiosk  */

/**
 * Exchange the installation key held only by the kata-cabin browser for a
 * long-lived, scoped token. This is not a password login and cannot be used
 * to open the rest of the ERP.
 */
export async function kioskLogin(req: Request, res: Response) {
  const installationKey = req.header('x-kata-cabin-key');
  if (!keysMatch(installationKey, getKataCabinAccessKey())) {
    throw new HttpError(401, 'Kata cabin is not activated');
  }

  const username = process.env.KATA_CABIN_USERNAME || 'kata-cabin';
  const user = await prisma.user.findUnique({
    where: { username },
    select: { id: true, name: true, disabledAt: true },
  });
  if (!user) {
    throw new HttpError(503, `Create the dedicated '${username}' USER account before activating the kata cabin`);
  }
  if (user.disabledAt) throw new HttpError(403, 'The kata cabin account has been disabled.');

  const token = signServiceToken({
    userId: user.id,
    role: 'USER',
    sid: SERVICE_SESSION_ID,
    scope: 'KATA_CABIN',
    name: user.name,
  });
  res.json({ token, user: { id: user.id, name: user.name, username, role: 'USER' } });
}

/* ------------------------------------------------------------------ me etc */

export async function me(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Not authenticated');

  if (req.user.scope === 'KATA_CABIN') {
    return res.json({
      user: {
        id: req.user.userId,
        name: req.user.name || 'Kata Cabin',
        username: process.env.KATA_CABIN_USERNAME || 'kata-cabin',
        role: 'USER',
        email: null,
        mustChangePassword: false,
        mfaEnrolled: false,
        mfaEnrolmentRequired: false,
      },
    });
  }

  const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
  if (!user) throw new HttpError(404, 'User not found');

  res.json({ user: { ...shapeUser(user), createdAt: user.createdAt } });
}

/**
 * Called by the browser while someone is actually using the app. requireAuth
 * has already refreshed lastSeenAt, so there is nothing left to do here.
 */
export async function heartbeat(_req: Request, res: Response) {
  res.json({ ok: true });
}

/** Drop this device's session so it stops counting against the cap. */
export async function logout(req: Request, res: Response) {
  const sid = req.user?.sid;
  if (sid && sid !== SERVICE_SESSION_ID) {
    await prisma.userSession.deleteMany({ where: { id: sid } });
    forgetSession(sid);
  }
  res.json({ ok: true });
}

/** Sign out everywhere, for someone who thinks their account is compromised. */
export async function logoutEverywhere(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  await revokeSessions(req.user.userId, null);
  res.json({ ok: true });
}
