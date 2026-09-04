import { z } from 'zod';
import { wishCategoryEnum } from './wishes.schema.js';

export const createTransportSchema = z.object({
  name: z.string().min(1, 'Name is required').trim(),
  code: z.string().trim().optional().nullable(),
  phone: z.string().trim().optional().nullable(),
  phone2: z.string().trim().optional().nullable(),
  email: z.string().email().optional().nullable().or(z.literal('')),
  address: z.string().trim().optional().nullable(),
  city: z.string().trim().optional().nullable(),
  state: z.string().trim().optional().nullable(),
  pincode: z.string().trim().optional().nullable(),
  gstin: z.string().trim().optional().nullable(),
  contactPerson: z.string().trim().optional().nullable(),
  defaultRetention: z.union([z.number(), z.string()]).transform((v) => Number(v) || 0).default(0),
  notes: z.string().trim().optional().nullable(),
  religion: wishCategoryEnum.optional().nullable(),
  active: z.boolean().default(true),
});

export const updateTransportSchema = createTransportSchema.partial();

export type CreateTransportInput = z.infer<typeof createTransportSchema>;
export type UpdateTransportInput = z.infer<typeof updateTransportSchema>;
