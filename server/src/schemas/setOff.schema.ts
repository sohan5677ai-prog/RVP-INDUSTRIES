import { z } from 'zod';

// No paise anywhere in the ERP: money inputs are rounded to whole rupees on entry.
const wholeRupee = z.coerce.number().transform((v) => Math.round(v));

// One purchase bill's share of the knock-off. `kind` mirrors the Purchase Dues
// page: a GRAIN bill is a verified Purchase row (settled by a purchaseId-linked
// payment), a DUST bill lives in its own table and is settled by a payment
// tagged `DUST:<id>:…` instead.
const purchaseLegSchema = z.object({
  kind: z.enum(['GRAIN', 'DUST']),
  id: z.string().min(1),
  amount: wholeRupee.pipe(z.number().positive()),
});

// One sale invoice's share of the knock-off.
const saleLegSchema = z.object({
  saleDispatchId: z.string().min(1),
  amount: wholeRupee.pipe(z.number().positive()),
});

export const createSetOffSchema = z.object({
  date: z.coerce.date(),
  partyId: z.string().min(1),
  note: z.string().optional().nullable(),
  purchases: z.array(purchaseLegSchema).min(1),
  sales: z.array(saleLegSchema).min(1),
});

export type CreateSetOffInput = z.infer<typeof createSetOffSchema>;

export const listSetOffsSchema = z.object({
  partyId: z.string().optional(),
});
