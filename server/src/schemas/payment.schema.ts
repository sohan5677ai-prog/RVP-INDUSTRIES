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
  tripId: z.string().optional().nullable(),
  brokerId: z.string().optional().nullable(),
  lorryNumber: z.string().optional().nullable(),
  payee: z.string().optional().nullable(),
  reference: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  hamaliVerificationId: z.string().optional().nullable(),
});

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

// Correcting a payment already on the books. Only the fields the register's edit
// dialog exposes - the structural links (purchase / hamali verification /
// screenshot) are carried over by the controller rather than re-sent.
export const updatePaymentSchema = createPaymentSchema.omit({
  purchaseId: true,
  hamaliVerificationId: true,
});

export type UpdatePaymentInput = z.infer<typeof updatePaymentSchema>;

export const listPaymentsSchema = z.object({
  skip: z.coerce.number().int().nonnegative().optional(),
  take: z.coerce.number().int().positive().optional().default(100),
  all: z.enum(['true', 'false']).optional(),
  // Drop the payment-side legs of party set-offs. They are not money leaving the
  // bank, so the Payments REGISTER hides them - but the dues/FIFO consumers must
  // keep seeing them, since a leg is what clears its purchase bill.
  excludeSetOffs: z.enum(['true', 'false']).optional(),
});
