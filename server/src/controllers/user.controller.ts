import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { describeUserAgent } from '../lib/userAgent.js';
import { liveSessionCutoff } from '../lib/sessionPolicy.js';
import { z } from 'zod';

const userSchema = z.object({
  name: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(6),
  role: z.enum(['ADMIN', 'USER', 'OWNER', 'DEVELOPER']),
});

const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  username: z.string().min(1).optional(),
  password: z.string().min(6).optional(),
  role: z.enum(['ADMIN', 'USER', 'OWNER', 'DEVELOPER']).optional(),
});

export async function listUsers(req: Request, res: Response) {
  const users = await prisma.user.findMany({
    select: { id: true, name: true, username: true, role: true, createdAt: true },
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

  res.json(
    visible.map(u => ({
      ...u,
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

  const hashedPassword = await bcrypt.hash(data.password, 10);
  const user = await prisma.user.create({
    data: {
      ...data,
      password: hashedPassword,
    },
    select: { id: true, name: true, username: true, role: true }
  });
  res.status(201).json(user);
}

export async function updateUser(req: Request, res: Response) {
  const data = updateUserSchema.parse(req.body);

  if (req.user?.role !== 'DEVELOPER') {
    if (data.role === 'DEVELOPER') {
      throw new HttpError(403, 'Only a developer can grant the developer role');
    }
    const target = await prisma.user.findUnique({ where: { id: req.params.id }, select: { role: true } });
    if (target?.role === 'DEVELOPER') {
      throw new HttpError(403, 'Only a developer can modify a developer account');
    }
  }

  const updateData: any = { ...data };
  if (data.password) {
    updateData.password = await bcrypt.hash(data.password, 10);
  }

  const user = await prisma.user.update({
    where: { id: req.params.id },
    data: updateData,
    select: { id: true, name: true, username: true, role: true }
  });
  res.json(user);
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
