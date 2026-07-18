import { z } from 'zod';

export const createNoteSchema = z.object({
  partyId: z.string().min(1, 'Party is required'),
  saleDispatchId: z.string().optional(),
  noteDate: z.coerce.date().optional(),
  reason: z.string().min(1, 'Reason is required'),
  taxableValue: z.coerce.number().positive('Taxable value must be positive'),
  gstRate: z.coerce.number().min(0).max(100),
});

export type CreateNoteInput = z.infer<typeof createNoteSchema>;
