import { z } from 'zod';

export const saleStatusEnum = z.enum(['PENDING', 'PARTIAL', 'DISPATCHED', 'DELIVERED']);
export const saleProductEnum = z.enum(['PAPPU', 'HUSK', 'WASTE', 'TPS', 'SHELL', 'PRECLEANER_DUST', 'NALLA_POKKULU', 'NALLA_CHINTAPANDU']);

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
  // Optional dispatch reminder date for advance orders (reminders fire 3 days before).
  reminderDate: z.coerce.date().optional().nullable(),
  marginOverride: z.boolean().optional().default(false),
  // When true, bill this order without GST.
  gstExempt: z.boolean().optional().default(false),
  brokerageRatePerKg: z.coerce.number().nonnegative().optional().default(0),
  // Destination + freight are derived from the buyer's party - not taken from the client.
});

// Multipart on dispatch: confirmed values read off the kata slip. The tax invoice
// is raised (auto-numbered) as a separate step afterwards.
export const dispatchSaleOrderSchema = z.object({
  vehicleNumber: z.string().optional().nullable(),
  driverName: z.string().optional().nullable(),
  driverPhone: z.string().optional().nullable(),
  tonnageKg: z.coerce.number().int().positive(),
  internalWeightKg: z.coerce.number().int().positive().optional().nullable(),
  transportProvider: z.enum(['SURYA', 'KNM', 'OTHER']).optional().default('SURYA'),
  customRetention: z.coerce.number().nonnegative().optional().nullable(),
});

export const listSaleOrdersSchema = z.object({
  status: saleStatusEnum.optional(),
  product: saleProductEnum.optional(),
  skip: z.coerce.number().int().nonnegative().optional(),
  take: z.coerce.number().int().positive().optional().default(100),
  all: z.enum(['true', 'false']).optional()
});

// Mark a dispatched shipment as delivered. The only valid transition is
// DISPATCHED -> DELIVERED, so status is not taken from the client - we just record
// the buyer's kata weight (optional) to compute any shortage credit note.
export const deliverSaleDispatchSchema = z.object({
  buyerKataKg: z.coerce.number().int().positive().optional(),
  // Delivered date as confirmed by the user (defaults to now); dues are calculated from this date.
  deliveredDate: z.coerce.date().optional(),
});

export const markPaidSchema = z.object({
  date: z.coerce.date(),
  amount: z.coerce.number().nonnegative(),
  tdsAmount: z.coerce.number().nonnegative().optional().default(0),
  shortageAmount: z.coerce.number().nonnegative().optional().default(0),
});

export type CreateSaleOrderInput = z.infer<typeof createSaleOrderSchema>;
export type DeliverSaleDispatchInput = z.infer<typeof deliverSaleDispatchSchema>;
export type DispatchSaleOrderInput = z.infer<typeof dispatchSaleOrderSchema>;
export type MarkPaidInput = z.infer<typeof markPaidSchema>;
