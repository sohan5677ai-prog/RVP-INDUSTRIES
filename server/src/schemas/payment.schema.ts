import { z } from 'zod';
import { PAYMENT_TYPES } from '../services/ledger.service.js';

// No paise anywhere in the ERP: money inputs are rounded to whole rupees on entry.
const wholeRupee = z.coerce.number().transform((v) => Math.round(v));

export const createPaymentSchema = z.object({
  date: z.coerce.date(),
  amount: wholeRupee.pipe(z.number().positive()),
  type: z.enum(PAYMENT_TYPES),
  partyId: z.string().optional().nullable(),
  purchaseId: z.string().optional().nullable(),
  brokerId: z.string().optional().nullable(),
  lorryNumber: z.string().optional().nullable(),
  payee: z.string().optional().nullable(),
  reference: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  hamaliVerificationId: z.string().optional().nullable(),
});

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

export const listPaymentsSchema = z.object({
  skip: z.coerce.number().int().nonnegative().optional(),
  take: z.coerce.number().int().positive().optional().default(100),
  all: z.enum(['true', 'false']).optional()
});
