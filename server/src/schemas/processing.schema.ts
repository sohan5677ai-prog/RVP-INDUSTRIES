import { z } from 'zod';

export const createProcessingSchema = z.object({
  blackWeightKg: z.coerce.number().int().positive(),
  outTurnPct: z.preprocess((val) => (val === null || val === undefined || val === '' ? undefined : Number(val)), z.number().positive().max(100).optional()),
  processDate: z.coerce.date(),
  purchaseId: z.string().optional().nullable(),
  overheadElectricity: z.coerce.number().nonnegative().optional().default(0),
  overheadWages: z.coerce.number().nonnegative().optional().default(0),
  overheadMaintenance: z.coerce.number().nonnegative().optional().default(0),
  loadingLocation: z.enum(['RVP', 'PGR COLD', 'Murugan', 'KNM Multi']).optional().default('RVP'),
});

export type CreateProcessingInput = z.infer<typeof createProcessingSchema>;
