import { z } from 'zod';
import { wishCategoryEnum } from './wishes.schema.js';

/**
 * A blank optional text field means "not set", not "the empty string".
 * `code` is @unique in the database, so storing '' for the first transport
 * left without a code made every later blank-code transport collide on
 * Transport_code_key - which surfaced as a bare "Internal server error" on
 * the Add Transport form. Postgres allows any number of NULLs in a unique
 * column, so normalising blanks to null is what makes the field optional.
 */
const optionalText = z
  .string()
  .trim()
  .optional()
  .nullable()
  .transform((v) => (v ? v : null));

export const createTransportSchema = z.object({
  name: z.string().min(1, 'Name is required').trim(),
  code: optionalText,
  phone: optionalText,
  phone2: optionalText,
  email: optionalText.refine((v) => v === null || z.string().email().safeParse(v).success, {
    message: 'Enter a valid email address',
  }),
  address: optionalText,
  city: optionalText,
  state: optionalText,
  pincode: optionalText,
  gstin: optionalText,
  contactPerson: optionalText,
  defaultRetention: z.union([z.number(), z.string()]).transform((v) => Number(v) || 0).default(0),
  /** Single-owner fleet - freight receipts go to the owner's phone, not the driver's. */
  payToOwner: z.boolean().default(false),
  notes: optionalText,
  religion: wishCategoryEnum.optional().nullable(),
  active: z.boolean().default(true),
});

export const updateTransportSchema = createTransportSchema.partial();

export type CreateTransportInput = z.infer<typeof createTransportSchema>;
export type UpdateTransportInput = z.infer<typeof updateTransportSchema>;
