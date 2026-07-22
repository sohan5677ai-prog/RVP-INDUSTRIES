import { z } from 'zod';

export const createLoanSchema = z.object({
  principal: z.coerce.number().positive(),
  name: z.string().trim().optional().nullable(),
  personName: z.string().trim().optional().nullable(),
  drawdownDate: z.coerce.date(),
  loanRef: z.string().trim().optional().nullable(),
  bankName: z.string().trim().optional().nullable(),
  location: z.string().trim().optional().nullable(),
  // Optional per-loan rate; defaults to the global CompanyProfile rate.
  interestRatePct: z.coerce.number().nonnegative().optional(),
  notes: z.string().trim().optional().nullable(),
});

export const createRepaymentSchema = z.object({
  amount: z.coerce.number().positive(), // principal portion — reduces the loan's outstanding
  interest: z.coerce.number().nonnegative().optional(), // interest portion — settles the 20280 accrual
  date: z.coerce.date(),
  reference: z.string().trim().optional().nullable(),
});

export const updateLoanSettingsSchema = z.object({
  loanInterestRatePct: z.coerce.number().nonnegative(),
});

export type CreateLoanInput = z.infer<typeof createLoanSchema>;
export type CreateRepaymentInput = z.infer<typeof createRepaymentSchema>;
