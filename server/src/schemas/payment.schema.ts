import { z } from 'zod';

export const createPaymentSchema = z.object({
  date: z.coerce.date(),
  amount: z.coerce.number().positive(),
  type: z.enum(['SUPPLIER', 'TRANSPORTER', 'BROKER', 'OTHER']),
  partyId: z.string().optional().nullable(),
  brokerId: z.string().optional().nullable(),
  lorryNumber: z.string().optional().nullable(),
  reference: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
});

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
