import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
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

export async function listUsers(_req: Request, res: Response) {
  const users = await prisma.user.findMany({
    select: { id: true, name: true, username: true, role: true, createdAt: true },
    orderBy: { createdAt: 'desc' }
  });
  res.json(users);
}

export async function createUser(req: Request, res: Response) {
  const data = userSchema.parse(req.body);
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
  await prisma.user.delete({ where: { id: req.params.id } });
  res.json({ message: 'User deleted' });
}
