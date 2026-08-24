import { z } from 'zod';

export const createUserNoteSchema = z.object({
  title: z.string().trim().max(150).optional().nullable(),
  content: z.string().trim().min(1, 'Please write something for your note/comment').max(5000),
  category: z.enum(['NOTE', 'REMINDER', 'TODO', 'COMMENT']).default('NOTE'),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
  isReminder: z.boolean().default(false),
  reminderDate: z
    .string()
    .datetime({ offset: true })
    .optional()
    .nullable()
    .or(z.string().regex(/^\d{4}-\d{2}-\d{2}/).transform((v) => new Date(v).toISOString()))
    .or(z.date().transform((d) => d.toISOString())),
  color: z.string().trim().max(30).optional().nullable().default('amber'),
  pinned: z.boolean().optional().default(false),
  pagePath: z.string().trim().max(300).optional().nullable(),
  pageLabel: z.string().trim().max(120).optional().nullable(),
});

export const updateUserNoteSchema = z.object({
  title: z.string().trim().max(150).optional().nullable(),
  content: z.string().trim().min(1, 'Content cannot be empty').max(5000).optional(),
  category: z.enum(['NOTE', 'REMINDER', 'TODO', 'COMMENT']).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  isReminder: z.boolean().optional(),
  reminderDate: z
    .string()
    .datetime({ offset: true })
    .optional()
    .nullable()
    .or(z.string().regex(/^\d{4}-\d{2}-\d{2}/).transform((v) => new Date(v).toISOString()))
    .or(z.date().transform((d) => d.toISOString())),
  color: z.string().trim().max(30).optional().nullable(),
  pinned: z.boolean().optional(),
  status: z.enum(['PENDING', 'COMPLETED']).optional(),
});

export type CreateUserNoteInput = z.infer<typeof createUserNoteSchema>;
export type UpdateUserNoteInput = z.infer<typeof updateUserNoteSchema>;
