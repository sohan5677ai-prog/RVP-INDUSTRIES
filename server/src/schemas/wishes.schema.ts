import { z } from 'zod';

export const wishCategoryEnum = z.enum(['HINDU', 'MUSLIM', 'CHRISTIAN', 'OTHER']);

export const createDriverSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  phone: z.string().min(1, 'Phone is required'),
  religion: wishCategoryEnum.optional().nullable(),
});
export const updateDriverSchema = createDriverSchema.partial().extend({
  active: z.boolean().optional(),
});

export const bulkTagReligionSchema = z.object({
  partyIds: z.array(z.string()).min(1, 'Select at least one party').optional(),
  brokerIds: z.array(z.string()).min(1, 'Select at least one broker').optional(),
  transportIds: z.array(z.string()).min(1, 'Select at least one transport').optional(),
  religion: wishCategoryEnum.nullable(),
});

/** Which recipient groups a preview/send call targets - all default true. */
export const recipientGroupsSchema = z.object({
  category: wishCategoryEnum.optional().nullable(),
  includeParties: z.boolean().default(true),
  includeBrokers: z.boolean().default(true),
  includeTransports: z.boolean().default(true),
  includeDrivers: z.boolean().default(true),
  includeOwners: z.boolean().default(true),
  partyIds: z.array(z.string()).optional(),
});

export const generateWishSchema = z.object({
  occasion: z.string().min(1, 'Occasion is required'),
  category: wishCategoryEnum.optional().nullable(),
});

export const sendWishSchema = recipientGroupsSchema.extend({
  occasion: z.string().min(1, 'Occasion is required'),
  messageText: z.string().min(1, 'Message is required'),
  imageUrl: z.string().optional().nullable(),
});

export type CreateDriverInput = z.infer<typeof createDriverSchema>;
export type UpdateDriverInput = z.infer<typeof updateDriverSchema>;
