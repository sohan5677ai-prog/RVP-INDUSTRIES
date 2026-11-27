import { z } from 'zod';

export const MANUAL_HAMALI_TYPES = [
  'BAG_CUTTING_NORMAL',
  'BAG_CUTTING_DISTANCE',
  'PAPPU_NET',
  'TPS_BROKENS_PACKING',
  'TAMARIND_BYPRODUCTS_PACKING',
  'PAPPU_TRANSFER',
  'TARBAL_FEE',
  'MISC',
  'PAID',
  'ADVANCE',
] as const;

export const PER_BAG_TYPES = [
  'BAG_CUTTING_NORMAL',
  'BAG_CUTTING_DISTANCE',
  'PAPPU_NET',
  'TPS_BROKENS_PACKING',
  'TAMARIND_BYPRODUCTS_PACKING',
] as const;

// Charged per tonne moved. Pappu Transfer = Pappu shifted from the mill to a
// storage - only the loads the user records, never every Pappu sale.
export const PER_TONNE_TYPES = ['PAPPU_TRANSFER'] as const;

export const createManualHamaliCostSchema = z
  .object({
    date: z.coerce.date(),
    type: z.enum(MANUAL_HAMALI_TYPES),
    bags: z.coerce.number().int().positive().optional().nullable(),
    ratePerBag: z.coerce.number().positive().optional().nullable(),
    weightKg: z.coerce.number().int().positive().optional().nullable(),
    ratePerTonne: z.coerce.number().positive().optional().nullable(),
    amount: z.coerce.number().positive().optional().nullable(),
    note: z.string().trim().optional().nullable(),
    // Pappu Transfer only
    toLocation: z.string().trim().max(80).optional().nullable(),
    lorryNumber: z.string().trim().max(20).optional().nullable(),
  })
  .refine(
    (d) =>
      (PER_BAG_TYPES as readonly string[]).includes(d.type)
        ? d.bags != null && d.ratePerBag != null
        : (PER_TONNE_TYPES as readonly string[]).includes(d.type)
          ? d.weightKg != null
          : d.amount != null,
    {
      message:
        'Per-bag charges require bags and rate per bag; per-tonne charges require a weight; flat charges require an amount',
    },
  );

export type CreateManualHamaliCostInput = z.infer<typeof createManualHamaliCostSchema>;
