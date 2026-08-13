import { z } from 'zod';

export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  /** Stable per-browser id; drives the two-device cap. */
  deviceId: z.string().min(8).max(128),
});

export type LoginInput = z.infer<typeof loginSchema>;
