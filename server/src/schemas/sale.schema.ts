import { z } from 'zod';

export const saleStatusEnum = z.enum(['PENDING', 'DISPATCHED', 'REACHED']);
export const saleProductEnum = z.enum(['PAPPU', 'HUSK', 'WASTE', 'TPS', 'SHELL']);

export const createSaleOrderSchema = z.object({
  saleDate: z.coerce.date(),
  product: saleProductEnum.optional().default('PAPPU'),
  buyerId: z.string().min(1),
  brokerId: z.string().min(1).optional().nullable(),
  // Total weight ordered, in kg (the UI enters tonnes and converts). On dispatch
  // this is replaced by the actual kata weight.
  tonnageKg: z.coerce.number().int().positive(),
  ratePerKg: z.coerce.number().positive(),
  // Credit period in days; the clock starts from the received (REACHED) date.
  dueDays: z.coerce.number().int().nonnegative().optional().nullable(),
  marginOverride: z.boolean().optional().default(false),
  brokerageRatePerKg: z.coerce.number().nonnegative().optional().default(0),
  // Destination + freight are derived from the buyer's party — not taken from the client.
});

// Multipart on dispatch: confirmed values read off the kata slip. The tax invoice
// is raised (auto-numbered) as a separate step afterwards.
export const dispatchSaleOrderSchema = z.object({
  vehicleNumber: z.string().optional().nullable(),
  tonnageKg: z.coerce.number().int().positive(),
});

export const listSaleOrdersSchema = z.object({
  status: saleStatusEnum.optional(),
  product: saleProductEnum.optional(),
});

// Mark a dispatched order as reached. The only valid transition is
// DISPATCHED -> REACHED, so status is not taken from the client — we just record
// the buyer's kata weight (optional) to compute any shortage credit note.
export const advanceSaleStatusSchema = z.object({
  buyerKataKg: z.coerce.number().int().positive().optional(),
});

export type CreateSaleOrderInput = z.infer<typeof createSaleOrderSchema>;
export type AdvanceSaleStatusInput = z.infer<typeof advanceSaleStatusSchema>;
export type DispatchSaleOrderInput = z.infer<typeof dispatchSaleOrderSchema>;
