import { z } from 'zod';

export const MANUAL_HAMALI_TYPES = [
  'BAG_CUTTING_NORMAL',
  'BAG_CUTTING_DISTANCE',
  'PAPPU_NET',
  'HUSK_PACKING',
  'TPS_BROKENS_PACKING',
  'TAMARIND_BYPRODUCTS_PACKING',
  'DIESEL',
  'MISC',
  'PAID',
] as const;

export const PER_BAG_TYPES = [
  'BAG_CUTTING_NORMAL',
  'BAG_CUTTING_DISTANCE',
  'PAPPU_NET',
  'HUSK_PACKING',
  'TPS_BROKENS_PACKING',
  'TAMARIND_BYPRODUCTS_PACKING',
] as const;

export const createManualHamaliCostSchema = z
  .object({
    date: z.coerce.date(),
    type: z.enum(MANUAL_HAMALI_TYPES),
    bags: z.coerce.number().int().positive().optional().nullable(),
    ratePerBag: z.coerce.number().positive().optional().nullable(),
    amount: z.coerce.number().positive().optional().nullable(),
    note: z.string().trim().optional().nullable(),
  })
  .refine(
    (d) =>
      (PER_BAG_TYPES as readonly string[]).includes(d.type)
        ? d.bags != null && d.ratePerBag != null
        : d.amount != null,
    { message: 'Per-bag charges require bags and rate per bag; flat charges require an amount' },
  );

export type CreateManualHamaliCostInput = z.infer<typeof createManualHamaliCostSchema>;
