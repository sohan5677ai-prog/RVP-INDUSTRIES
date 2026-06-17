import { z } from 'zod';

export const saleStatusEnum = z.enum(['PENDING', 'DISPATCHED', 'COMPLETED', 'CANCELLED']);

export const createSaleOrderSchema = z.object({
  saleDate: z.coerce.date(),
  buyerId: z.string().min(1),
  brokerId: z.string().min(1).optional().nullable(),
  tonnageKg: z.coerce.number().int().positive(),
  ratePerKg: z.coerce.number().positive(),
  marginOverride: z.boolean().optional().default(false),
});

export const listSaleOrdersSchema = z.object({
  status: saleStatusEnum.optional(),
});

// Multipart: values arrive as strings.
export const createSaleDispatchSchema = z.object({
  saleOrderId: z.string().min(1),
  dispatchDate: z.coerce.date(),
  dispatchWeightKg: z.coerce.number().int().positive(),
});

export type CreateSaleOrderInput = z.infer<typeof createSaleOrderSchema>;
export type CreateSaleDispatchInput = z.infer<typeof createSaleDispatchSchema>;
