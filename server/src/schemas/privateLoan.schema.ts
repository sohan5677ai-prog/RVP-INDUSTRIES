import { z } from 'zod';

export const createPrivateLoanSchema = z.object({
  borrowerName: z.string().trim().min(1),
  phone: z.string().trim().optional().nullable(),
  phone2: z.string().trim().optional().nullable(),
  principal: z.coerce.number().positive(),
  startDate: z.coerce.date(),
  // Always ANNUAL - the client converts a monthly-entered rate before sending.
  interestRatePct: z.coerce.number().nonnegative(),
  // Which unit the rate was entered/is displayed in - display + WhatsApp
  // wording only, does not change how interestRatePct is interpreted.
  interestPeriod: z.enum(['ANNUAL', 'MONTHLY']).optional(),
  notes: z.string().trim().optional().nullable(),
  waLanguage: z.enum(['EN', 'TE', 'TA', 'KN', 'HI']).optional(),
});

export const createPrivateLoanRepaymentSchema = z.object({
  amount: z.coerce.number().positive(), // principal portion - reduces the loan's outstanding
  interest: z.coerce.number().nonnegative().optional(), // interest portion - booked to Interest Income
  date: z.coerce.date(),
  reference: z.string().trim().optional().nullable(),
  // Close the loan on this repayment even if a small principal residue remains.
  closeLoan: z.boolean().optional(),
});

export type CreatePrivateLoanInput = z.infer<typeof createPrivateLoanSchema>;
export type CreatePrivateLoanRepaymentInput = z.infer<typeof createPrivateLoanRepaymentSchema>;
