import { z } from 'zod';
import { RECEIPT_TYPES } from '../services/ledger.service.js';

// No paise anywhere in the ERP: money inputs are rounded to whole rupees on entry.
const wholeRupee = z.coerce.number().transform((v) => Math.round(v));

export const createReceiptSchema = z.object({
  date: z.coerce.date(),
  amount: wholeRupee.pipe(z.number().min(0)),
  tdsAmount: wholeRupee.pipe(z.number().min(0)).optional().nullable(),
  shortageAmount: wholeRupee.pipe(z.number().min(0)).optional().nullable(),
  type: z.enum(RECEIPT_TYPES),
  partyId: z.string().optional().nullable(),
  saleDispatchId: z.string().optional().nullable(),
  payer: z.string().optional().nullable(),
  reference: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
});

export type CreateReceiptInput = z.infer<typeof createReceiptSchema>;

export const listReceiptsSchema = z.object({
  skip: z.coerce.number().int().nonnegative().optional(),
  take: z.coerce.number().int().positive().optional().default(100),
  all: z.enum(['true', 'false']).optional()
});
