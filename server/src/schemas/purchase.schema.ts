import { z } from 'zod';

export const poStatusEnum = z.enum(['PENDING', 'ARRIVED', 'COMPLETED', 'CANCELLED']);

export const createPurchaseOrderSchema = z.object({
  poDate: z.coerce.date(),
  partyId: z.string().min(1),
  pricePerKg: z.coerce.number().positive(),
  tonnageKg: z.coerce.number().int().positive(), // already in kg (FE converts tonnes -> kg)
  lorryCount: z.preprocess((val) => (val === null || val === undefined || val === '' ? null : Number(val)), z.number().int().positive().nullable().optional()),
});

export const listPurchaseOrdersSchema = z.object({
  status: poStatusEnum.optional(),
});

// Multipart: all values arrive as strings, so coerce.
export const createStockInSchema = z.object({
  purchaseOrderId: z.string().min(1),
  arrivalDate: z.coerce.date(),
  lorryNumber: z.string().min(1),
  invoiceNumber: z.string().min(1),
  rvpFirstWeightKg: z.coerce.number().int().positive(), // loaded/gross weight
  rvpSecondWeightKg: z.coerce.number().int().nonnegative().optional().default(0), // empty/tare weight
  billingWeightKg: z.coerce.number().int().positive(),
  partyKataKg: z.coerce.number().int().positive(),
  loadingLocation: z.enum(['At process', 'Rampalli', 'Murgan', 'Multi']).optional().default('At process'),
  carterDistanceKm: z.coerce.number().int().nonnegative().optional().default(50),
});

export const createPurchaseSchema = z.object({
  stockInId: z.string().min(1),
  rvpSecondWeightKg: z.coerce.number().int().positive(),
  hamaliRate: z.preprocess((val) => (val === null || val === undefined || val === '' ? undefined : Number(val)), z.number().nonnegative().optional()),
});

export const createVerificationSchema = z.object({
  purchaseId: z.string().min(1),
  discountType: z.enum(['WEIGHT', 'PRICE', 'AMOUNT']).optional().nullable(),
  discountValue: z.coerce.number().nonnegative().optional().default(0),
  carterCharge: z.coerce.number().nonnegative().optional().default(0),
});

export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderSchema>;
export type CreateStockInInput = z.infer<typeof createStockInSchema>;
export type CreatePurchaseInput = z.infer<typeof createPurchaseSchema>;
export type CreateVerificationInput = z.infer<typeof createVerificationSchema>;
