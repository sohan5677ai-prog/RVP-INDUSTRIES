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
  amount: z.coerce.number().positive(), // principal portion - reduces the loan's outstanding
  interest: z.coerce.number().nonnegative().optional(), // interest portion - settles the 20280 accrual
  date: z.coerce.date(),
  reference: z.string().trim().optional().nullable(),
  // Close the loan on this repayment even if a small principal residue remains -
  // the bank's own interest/settlement figure rarely matches ours to the paisa.
  closeLoan: z.boolean().optional(),
});

export const updateLoanSettingsSchema = z.object({
  loanInterestRatePct: z.coerce.number().nonnegative(),
});

export type CreateLoanInput = z.infer<typeof createLoanSchema>;
export type CreateRepaymentInput = z.infer<typeof createRepaymentSchema>;
