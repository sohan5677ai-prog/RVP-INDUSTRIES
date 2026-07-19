import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { signToken } from '../lib/jwt.js';
import { HttpError } from '../lib/httpError.js';
import { loginSchema } from '../schemas/auth.schema.js';

// Dummy hash so bcrypt.compare always runs, even for unknown usernames -
// keeps response timing the same whether or not the account exists.
const DUMMY_HASH = '$2a$10$CwTycUXWue0Thq9StjUM0uJ8Q8lPZC.jQBnQXvhO1kZWm.wZ5ymPO';

export async function login(req: Request, res: Response) {
  const { username, password } = loginSchema.parse(req.body);

  const user = await prisma.user.findUnique({ where: { username } });

  const ok = await bcrypt.compare(password, user?.password ?? DUMMY_HASH);
  if (!user || !ok) throw new HttpError(401, 'Invalid credentials');

  const token = signToken({ userId: user.id, role: user.role });
  res.json({
    token,
    user: { id: user.id, name: user.name, username: user.username, role: user.role },
  });
}

export async function me(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Not authenticated');

  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
    select: { id: true, name: true, username: true, role: true, createdAt: true },
  });
  if (!user) throw new HttpError(404, 'User not found');

  res.json({ user });
}
