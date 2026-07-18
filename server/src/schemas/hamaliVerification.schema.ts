import { z } from 'zod';

export const createHamaliVerificationSchema = z.object({
  asOfDate: z.coerce.date(),
  periodStart: z.coerce.date().optional().nullable(),
  crewTotal: z.coerce.number().min(0),
  note: z.string().trim().optional().nullable(),
});

export type CreateHamaliVerificationInput = z.infer<typeof createHamaliVerificationSchema>;
