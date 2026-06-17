import { z } from 'zod';

export const partyTypeEnum = z.enum(['SUPPLIER', 'BUYER', 'BOTH']);

export const createPartySchema = z.object({
  name: z.string().min(1, 'Name is required'),
  type: partyTypeEnum.default('SUPPLIER'),
  phone: z.string().optional(),
  address: z.string().optional(),
});

export const updatePartySchema = createPartySchema.partial();

export type CreatePartyInput = z.infer<typeof createPartySchema>;
export type UpdatePartyInput = z.infer<typeof updatePartySchema>;
