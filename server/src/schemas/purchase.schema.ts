import { z } from 'zod';

export const poStatusEnum = z.enum(['PENDING', 'ARRIVED', 'COMPLETED', 'CANCELLED']);

export const createPurchaseOrderSchema = z.object({
  poDate: z.coerce.date(),
  partyId: z.string().min(1),
  pricePerKg: z.coerce.number().positive(),
  priceType: z.enum(['BASE', 'DELIVERY']).optional().default('DELIVERY'),
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
  // Inward freight (₹) to bring BASE-priced stock to our location, captured at
  // arrival. Ignored downstream for DELIVERY-priced POs (freight already in price).
  freightCharge: z.coerce.number().nonnegative().optional().default(0),
});

export const createPurchaseSchema = z.object({
  stockInId: z.string().min(1),
  rvpSecondWeightKg: z.coerce.number().int().positive(),
  hamaliRate: z.preprocess((val) => (val === null || val === undefined || val === '' ? undefined : Number(val)), z.number().nonnegative().optional()),
  // Bunker the seed is poured into — only meaningful for stock landing directly
  // at the process. Drives the bag-cutting hamali (A = ₹3/bag, B = ₹6/bag).
  bunkerPlace: z.enum(['A', 'B']).optional().nullable(),
  // Inward freight is now captured at Stock In (see createStockInSchema) and
  // sourced from the StockIn record at purchase time, not from this request.
});

export const locationEnum = z.enum(['At process', 'Rampalli', 'Murgan', 'Multi']);

// Hamali (₹80/t unload + ₹270/t handling) and the ₹500 transport are fixed
// rates applied server-side, so they are not taken from the client.
export const createStockTransferSchema = z.object({
  fromLocation: z.enum(['Rampalli', 'Murgan', 'Multi']),
  toLocation: z.literal('At process').optional().default('At process'),
  weightKg: z.coerce.number().int().positive(),
  lorryNumber: z.string().optional().nullable(),
  bunkerPlace: z.enum(['A', 'B']).optional().nullable(),
  transferDate: z.coerce.date(),
});

// Tamarind shell transfer (process → Rampalli). Hamali ₹333/t and ₹500 transport
// are fixed server-side; weight + lorry + date come from the client.
export const createShellTransferSchema = z.object({
  weightKg: z.coerce.number().int().positive(),
  lorryNumber: z.string().optional().nullable(),
  transferDate: z.coerce.date(),
});

export const createVerificationSchema = z.object({
  purchaseId: z.string().min(1),
  discountType: z.enum(['WEIGHT', 'PRICE', 'AMOUNT']).optional().nullable(),
  discountValue: z.coerce.number().nonnegative().optional().default(0),
  forceExempt: z.boolean().optional().default(false),
});

export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderSchema>;
export type CreateStockInInput = z.infer<typeof createStockInSchema>;
export type CreatePurchaseInput = z.infer<typeof createPurchaseSchema>;
export type CreateVerificationInput = z.infer<typeof createVerificationSchema>;
export type CreateStockTransferInput = z.infer<typeof createStockTransferSchema>;
export type CreateShellTransferInput = z.infer<typeof createShellTransferSchema>;
