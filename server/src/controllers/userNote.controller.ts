import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { createUserNoteSchema, updateUserNoteSchema } from '../schemas/userNote.schema.js';

/**
 * List user notes & comments.
 * Query params:
 *  - status: 'PENDING' | 'COMPLETED' | 'ALL' (default 'ALL')
 *  - isReminder: 'true' | 'false'
 *  - category: 'NOTE' | 'REMINDER' | 'TODO' | 'COMMENT'
 *  - priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT'
 *  - search: text search in title & content
 *  - dueOnly: 'true' (reminders whose reminderDate <= end of today or overdue)
 */
export async function listUserNotes(req: Request, res: Response) {
  const { status, isReminder, category, priority, search, dueOnly } = req.query;

  const where: any = {};

  if (status && status !== 'ALL') {
    where.status = status as string;
  }

  if (isReminder !== undefined) {
    where.isReminder = isReminder === 'true';
  }

  if (category) {
    where.category = category as string;
  }

  if (priority) {
    where.priority = priority as string;
  }

  if (search && typeof search === 'string' && search.trim()) {
    const q = search.trim();
    where.OR = [
      { title: { contains: q, mode: 'insensitive' } },
      { content: { contains: q, mode: 'insensitive' } },
      { userName: { contains: q, mode: 'insensitive' } },
      { pageLabel: { contains: q, mode: 'insensitive' } },
    ];
  }

  if (dueOnly === 'true') {
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);
    where.isReminder = true;
    where.status = 'PENDING';
    where.reminderDate = { lte: endOfToday, not: null };
  }

  const rows = await prisma.userNote.findMany({
    where,
    orderBy: [
      { pinned: 'desc' },
      { reminderDate: 'asc' },
      { createdAt: 'desc' },
    ],
  });

  res.json(rows);
}

/**
 * Quick fetch of due / active reminders for the login & daily reminder popup.
 * Returns pending reminders that are due on or before today.
 */
export async function getDueUserReminders(_req: Request, res: Response) {
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);

  const rows = await prisma.userNote.findMany({
    where: {
      status: 'PENDING',
      isReminder: true,
      reminderDate: {
        lte: endOfToday,
        not: null,
      },
    },
    orderBy: [
      { priority: 'desc' },
      { reminderDate: 'asc' },
      { createdAt: 'desc' },
    ],
  });

  res.json(rows);
}

/**
 * Get a single note by ID.
 */
export async function getUserNote(req: Request, res: Response) {
  const row = await prisma.userNote.findUnique({
    where: { id: req.params.id },
  });
  if (!row) throw new HttpError(404, 'Note not found');
  res.json(row);
}

/**
 * Create a new user note or reminder.
 */
export async function createUserNote(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  const input = createUserNoteSchema.parse(req.body);

  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
    select: { name: true, role: true },
  });

  // If reminderDate is provided, auto-flag isReminder = true
  const isReminder = input.isReminder || Boolean(input.reminderDate) || input.category === 'REMINDER';

  const row = await prisma.userNote.create({
    data: {
      title: input.title || null,
      content: input.content,
      category: input.category,
      priority: input.priority,
      isReminder,
      reminderDate: input.reminderDate ? new Date(input.reminderDate) : null,
      status: 'PENDING',
      color: input.color || 'amber',
      pinned: input.pinned ?? false,
      pagePath: input.pagePath || null,
      pageLabel: input.pageLabel || null,
      userId: req.user.userId,
      userName: user?.name ?? 'User',
      userRole: user?.role ?? req.user.role ?? 'USER',
    },
  });

  res.status(201).json(row);
}

/**
 * Update an existing note.
 */
export async function updateUserNote(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  const input = updateUserNoteSchema.parse(req.body);

  const existing = await prisma.userNote.findUnique({
    where: { id: req.params.id },
  });
  if (!existing) throw new HttpError(404, 'Note not found');

  const data: any = {};
  if (input.title !== undefined) data.title = input.title;
  if (input.content !== undefined) data.content = input.content;
  if (input.category !== undefined) data.category = input.category;
  if (input.priority !== undefined) data.priority = input.priority;
  if (input.isReminder !== undefined) data.isReminder = input.isReminder;
  if (input.reminderDate !== undefined) {
    data.reminderDate = input.reminderDate ? new Date(input.reminderDate) : null;
    if (input.reminderDate && input.isReminder === undefined) {
      data.isReminder = true;
    }
  }
  if (input.color !== undefined) data.color = input.color;
  if (input.pinned !== undefined) data.pinned = input.pinned;
  if (input.status !== undefined) {
    data.status = input.status;
    if (input.status === 'COMPLETED') {
      const user = await prisma.user.findUnique({
        where: { id: req.user.userId },
        select: { name: true },
      });
      data.completedAt = new Date();
      data.completedById = req.user.userId;
      data.completedByName = user?.name ?? 'User';
    } else {
      data.completedAt = null;
      data.completedById = null;
      data.completedByName = null;
    }
  }

  const updated = await prisma.userNote.update({
    where: { id: req.params.id },
    data,
  });

  res.json(updated);
}

/**
 * Toggle status of a note between PENDING and COMPLETED.
 */
export async function toggleUserNoteStatus(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Not authenticated');

  const existing = await prisma.userNote.findUnique({
    where: { id: req.params.id },
  });
  if (!existing) throw new HttpError(404, 'Note not found');

  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
    select: { name: true },
  });

  const nextStatus = existing.status === 'COMPLETED' ? 'PENDING' : 'COMPLETED';
  const isDone = nextStatus === 'COMPLETED';

  const updated = await prisma.userNote.update({
    where: { id: req.params.id },
    data: {
      status: nextStatus,
      completedAt: isDone ? new Date() : null,
      completedById: isDone ? req.user.userId : null,
      completedByName: isDone ? (user?.name ?? 'User') : null,
    },
  });

  res.json(updated);
}

/**
 * Delete a user note.
 */
export async function deleteUserNote(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Not authenticated');

  const existing = await prisma.userNote.findUnique({
    where: { id: req.params.id },
  });
  if (!existing) throw new HttpError(404, 'Note not found');

  await prisma.userNote.delete({
    where: { id: req.params.id },
  });

  res.json({ success: true, id: req.params.id });
}
