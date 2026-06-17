import { z } from 'zod';

export const createBrokerSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  phone: z.string().optional(),
});

export type CreateBrokerInput = z.infer<typeof createBrokerSchema>;
