import { z } from 'zod';

export const createReceiptSchema = z.object({
  date: z.coerce.date(),
  amount: z.coerce.number().positive(),
  type: z.enum(['BUYER', 'OTHER']),
  partyId: z.string().optional().nullable(),
  reference: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
});

export type CreateReceiptInput = z.infer<typeof createReceiptSchema>;
