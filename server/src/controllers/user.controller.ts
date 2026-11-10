import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { describeUserAgent } from '../lib/userAgent.js';
import { liveSessionCutoff } from '../lib/sessionPolicy.js';
import { MAX_PASSWORD_LENGTH, validatePassword } from '../lib/passwordPolicy.js';
import { mfaRequiredFor } from '../lib/mfa.js';
import { hashPassword } from '../lib/passwordHash.js';
import { revokeSessions, setPassword } from '../services/identity.service.js';
import { PasswordAlgo } from '@prisma/client';
import { z } from 'zod';

const ROLES = ['ADMIN', 'USER', 'OWNER', 'DEVELOPER'] as const;

const userSchema = z.object({
  name: z.string().min(1),
  username: z.string().min(1),
  // Length is bounded here; the content policy is applied below, so the caller
  // gets the specific reasons rather than a bare "invalid".
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  role: z.enum(ROLES),
  email: z.string().email().max(254).optional(),
});

const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  username: z.string().min(1).optional(),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH).optional(),
  role: z.enum(ROLES).optional(),
  email: z.string().email().max(254).nullable().optional(),
  /** Soft offboarding: refuses login and kills live sessions. */
  disabled: z.boolean().optional(),
});

/** Apply the password policy and report every problem at once. */
function assertPolicy(password: string, ctx: { username?: string; name?: string; email?: string | null }) {
  const problems = validatePassword(password, ctx);
  if (problems.length > 0) throw new HttpError(400, problems.join(' '));
}

export async function listUsers(req: Request, res: Response) {
  const users = await prisma.user.findMany({
    select: {
      id: true, name: true, username: true, role: true, createdAt: true,
      email: true, mfaEnabledAt: true, disabledAt: true, lastLoginAt: true,
      lockedUntil: true, mustChangePassword: true, passwordChangedAt: true,
    },
    orderBy: { createdAt: 'desc' }
  });
  // The DEVELOPER role (licensing/subscription control) is invisible to
  // everyone else — only a DEVELOPER account may see other DEVELOPER accounts.
  const visible = req.user?.role === 'DEVELOPER' ? users : users.filter(u => u.role !== 'DEVELOPER');

  // Which devices each account is signed in on right now. Sessions past the
  // idle window are already dead - they neither show here nor hold a slot.
  const sessions = await prisma.userSession.findMany({
    where: { userId: { in: visible.map(u => u.id) }, lastSeenAt: { gte: liveSessionCutoff() } },
    orderBy: { lastSeenAt: 'desc' },
  });

  const now = new Date();
  res.json(
    visible.map(u => ({
      id: u.id,
      name: u.name,
      username: u.username,
      role: u.role,
      createdAt: u.createdAt,
      email: u.email,
      // Everything an access review needs to answer "who can get in, and how".
      mfaEnrolled: !!u.mfaEnabledAt,
      mfaRequired: mfaRequiredFor(u.role),
      disabled: !!u.disabledAt,
      lockedOut: !!u.lockedUntil && u.lockedUntil > now,
      mustChangePassword: u.mustChangePassword,
      lastLoginAt: u.lastLoginAt,
      passwordChangedAt: u.passwordChangedAt,
      devices: sessions
        .filter(s => s.userId === u.id)
        .map(s => ({
          id: s.id,
          // Short tag so two identical browsers are still tellable apart.
          tag: s.deviceId.slice(0, 8),
          label: describeUserAgent(s.userAgent),
          signedInAt: s.createdAt,
          lastSeenAt: s.lastSeenAt,
          current: s.id === req.user?.sid,
        })),
    }))
  );
}

export async function createUser(req: Request, res: Response) {
  const data = userSchema.parse(req.body);
  if (data.role === 'DEVELOPER' && req.user?.role !== 'DEVELOPER') {
    throw new HttpError(403, 'Only a developer can create a developer account');
  }
  const existing = await prisma.user.findUnique({ where: { username: data.username } });
  if (existing) throw new HttpError(400, 'Username already in use');
  if (data.email) {
    const byEmail = await prisma.user.findUnique({ where: { email: data.email } });
    if (byEmail) throw new HttpError(400, 'Email address already in use');
  }

  assertPolicy(data.password, { username: data.username, name: data.name, email: data.email });

  const user = await prisma.user.create({
    data: {
      name: data.name,
      username: data.username,
      role: data.role,
      email: data.email ?? null,
      password: await hashPassword(data.password),
      passwordAlgo: PasswordAlgo.ARGON2ID,
      // Whoever created this account knows the password, so it is not a secret
      // between the owner and the system until they have changed it.
      mustChangePassword: true,
    },
    select: { id: true, name: true, username: true, role: true, email: true }
  });
  res.status(201).json(user);
}

export async function updateUser(req: Request, res: Response) {
  const data = updateUserSchema.parse(req.body);

  const target = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: { id: true, role: true, name: true, username: true, email: true },
  });
  if (!target) throw new HttpError(404, 'User not found');

  if (req.user?.role !== 'DEVELOPER') {
    if (data.role === 'DEVELOPER') {
      throw new HttpError(403, 'Only a developer can grant the developer role');
    }
    if (target.role === 'DEVELOPER') {
      throw new HttpError(403, 'Only a developer can modify a developer account');
    }
  }

  if (data.email) {
    const byEmail = await prisma.user.findUnique({ where: { email: data.email } });
    if (byEmail && byEmail.id !== target.id) {
      throw new HttpError(400, 'Email address already in use');
    }
  }

  // A password set by an admin goes through the same policy, history and
  // revocation as one the owner sets - and forces a change at next sign-in,
  // because the admin knows it.
  if (data.password) {
    assertPolicy(data.password, {
      username: data.username ?? target.username,
      name: data.name ?? target.name,
      email: data.email ?? target.email,
    });
    await setPassword({
      userId: target.id,
      newPlain: data.password,
      keepSessionId: null,
      mustChangeNext: true,
    });
  }

  const roleChanged = !!data.role && data.role !== target.role;
  const beingDisabled = data.disabled === true;

  const user = await prisma.user.update({
    where: { id: target.id },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.username !== undefined ? { username: data.username } : {}),
      ...(data.role !== undefined ? { role: data.role } : {}),
      ...(data.email !== undefined ? { email: data.email } : {}),
      ...(data.disabled !== undefined
        ? { disabledAt: data.disabled ? new Date() : null }
        : {}),
      // Re-enabling clears the lock too, so an account disabled while locked
      // does not come back still locked.
      ...(data.disabled === false ? { lockedUntil: null, failedLoginCount: 0 } : {}),
    },
    select: { id: true, name: true, username: true, role: true, email: true, disabledAt: true }
  });

  // Plan item 1.5: sessions are invalidated on a role change as well as a
  // password change. A demotion must not leave the old role usable on a live
  // token, and a disable has to take effect at once rather than at idle.
  if (roleChanged || beingDisabled) {
    await revokeSessions(target.id, null);
  }

  res.json({ ...user, disabled: !!user.disabledAt });
}

export async function deleteUser(req: Request, res: Response) {
  const target = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: { id: true, role: true },
  });
  if (!target) throw new HttpError(404, 'User not found');

  // Nobody deletes the account they are signed in as - that is always a slip,
  // and it would strand the session mid-request.
  if (target.id === req.user?.userId) {
    throw new HttpError(400, 'You cannot delete your own account');
  }

  // A developer may remove anyone else. Everyone else may only remove ordinary
  // user accounts: admins, owners and developers are privileged and can only be
  // taken out by a developer.
  if (req.user?.role !== 'DEVELOPER' && target.role !== 'USER') {
    const article = /^[AEIOU]/.test(target.role) ? 'an' : 'a';
    throw new HttpError(403, `Only a developer can delete ${article} ${target.role.toLowerCase()} account`);
  }

  await prisma.user.delete({ where: { id: target.id } });
  res.json({ message: 'User deleted' });
}
