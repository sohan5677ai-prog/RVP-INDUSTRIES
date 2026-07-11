import { z } from 'zod';
import { PAYMENT_TYPES } from '../services/ledger.service.js';

export const createPaymentSchema = z.object({
  date: z.coerce.date(),
  amount: z.coerce.number().positive(),
  type: z.enum(PAYMENT_TYPES),
  partyId: z.string().optional().nullable(),
  purchaseId: z.string().optional().nullable(),
  brokerId: z.string().optional().nullable(),
  lorryNumber: z.string().optional().nullable(),
  payee: z.string().optional().nullable(),
  reference: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
});

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
