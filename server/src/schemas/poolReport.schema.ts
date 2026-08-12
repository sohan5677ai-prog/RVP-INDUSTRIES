import { z } from 'zod';

export const createGunnyBagSchema = z.object({
  date: z.coerce.date(),
  type: z.enum(['PURCHASE', 'SALE', 'PAYMENT']),
  quantity: z.coerce.number().int().positive().optional(), // null for PAYMENT entries
  amount: z.coerce.number().nonnegative(), // PURCHASE/SALE amount (for PAYMENT, this is the paid amount)
  note: z.string().trim().optional().nullable(),
});

export const createElectricityBillSchema = z.object({
  date: z.coerce.date(),
  month: z.string().trim().min(1),
  units: z.coerce.number().int().nonnegative().default(0),
  amount: z.coerce.number().nonnegative(),
  note: z.string().trim().optional().nullable(),
});

export const createMaintenanceExpenseSchema = z.object({
  date: z.coerce.date(),
  description: z.string().trim().min(1),
  amount: z.coerce.number().nonnegative(),
  note: z.string().trim().optional().nullable(),
});

export const createMiscExpenseSchema = z.object({
  date: z.coerce.date(),
  description: z.string().trim().min(1),
  amount: z.coerce.number().nonnegative(),
  note: z.string().trim().optional().nullable(),
});

export const createDrawingSchema = z.object({
  date: z.coerce.date(),
  owner: z.enum(['SHABRI', 'REDDY']),
  amount: z.coerce.number().positive(),
  note: z.string().trim().optional().nullable(),
});

export const createInterestChargeSchema = z.object({
  date: z.coerce.date(),
  type: z.enum(['CC', 'TERM_LOAN']),
  amount: z.coerce.number().positive(),
  note: z.string().trim().optional().nullable(),
});

export const createTermLoanPrincipalSchema = z.object({
  date: z.coerce.date(),
  amount: z.coerce.number().positive(),
  note: z.string().trim().optional().nullable(),
});

export const createStorageMaintenanceSchema = z.object({
  date: z.coerce.date(),
  kind: z.enum(['ELECTRICITY', 'SALARY']),
  label: z.string().trim().optional().nullable(),
  amount: z.coerce.number().positive(),
  note: z.string().trim().optional().nullable(),
});

export const createOtherIncomeSchema = z.object({
  date: z.coerce.date(),
  label: z.string().trim().min(1),
  amount: z.coerce.number().positive(),
  note: z.string().trim().optional().nullable(),
});

/** Manual one-off subscription charge (the recurring ones are generated). */
export const createSubscriptionChargeSchema = z.object({
  date: z.coerce.date(),
  plan: z.enum(['MONTHLY', 'YEARLY']),
  amount: z.coerce.number().positive(),
  dueDate: z.coerce.date().optional().nullable(),
  note: z.string().trim().optional().nullable(),
});

/** Partial edit of a plan's recurrence settings from the Subscription tab. */
export const updateSubscriptionPlanSchema = z.object({
  enabled: z.boolean().optional(),
  amount: z.coerce.number().positive().optional(),
  chargeDay: z.coerce.number().int().min(1).max(31).optional(),
  chargeMonth: z.coerce.number().int().min(1).max(12).optional().nullable(),
  dueDays: z.coerce.number().int().min(0).max(365).optional(),
  startDate: z.coerce.date().optional(),
});

export const createGunnySaleSchema = z.object({
  date: z.coerce.date(),
  bags: z.coerce.number().int().positive(),
  price: z.coerce.number().positive(),
  amount: z.coerce.number().positive(),
  note: z.string().trim().optional().nullable(),
});

