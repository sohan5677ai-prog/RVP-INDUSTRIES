import { z } from 'zod';
import { RECEIPT_TYPES } from '../services/ledger.service.js';

export const createReceiptSchema = z.object({
  date: z.coerce.date(),
  amount: z.coerce.number().min(0),
  tdsAmount: z.coerce.number().min(0).optional().nullable(),
  shortageAmount: z.coerce.number().min(0).optional().nullable(),
  type: z.enum(RECEIPT_TYPES),
  partyId: z.string().optional().nullable(),
  saleDispatchId: z.string().optional().nullable(),
  payer: z.string().optional().nullable(),
  reference: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
});

export type CreateReceiptInput = z.infer<typeof createReceiptSchema>;
