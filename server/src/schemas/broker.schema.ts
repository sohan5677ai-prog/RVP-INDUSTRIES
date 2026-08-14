import { z } from 'zod';

export const createBrokerSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  phone: z.string().optional(),
  // Brokers get the payment-reminder copy on their own phone, so they carry
  // their own language rather than inheriting the buyer's.
  waLanguage: z.enum(['EN', 'TE', 'TA', 'KN', 'HI']).optional(),
  // Flat brokerage credited per dispatched sale order under this broker.
  brokerageAmount: z.coerce.number().nonnegative().optional().default(2000),
});

export type CreateBrokerInput = z.infer<typeof createBrokerSchema>;
