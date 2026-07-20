import { z } from 'zod';

export const createGunnyBagSchema = z.object({
  date: z.coerce.date(),
  direction: z.enum(['PURCHASE', 'SALE']),
  quantity: z.coerce.number().int().positive(),
  amount: z.coerce.number().nonnegative(),
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
