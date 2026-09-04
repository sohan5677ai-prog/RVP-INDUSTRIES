import { z } from 'zod';
import { wishCategoryEnum } from './party.schema.js';

export const createBrokerSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  phone: z.string().optional().nullable(),
  // Brokers get the payment-reminder copy on their own phone, so they carry
  // their own language rather than inheriting the buyer's.
  waLanguage: z.enum(['EN', 'TE', 'TA', 'KN', 'HI']).optional(),
  // Settings -> Wishes targeting only (see WishCategory). Null = not tagged.
  religion: wishCategoryEnum.optional().nullable(),
  // Flat brokerage credited per dispatched sale order under this broker.
  brokerageAmount: z.coerce.number().nonnegative().optional().default(2000),
});

export const updateBrokerSchema = createBrokerSchema.partial();

export type CreateBrokerInput = z.infer<typeof createBrokerSchema>;
export type UpdateBrokerInput = z.infer<typeof updateBrokerSchema>;
