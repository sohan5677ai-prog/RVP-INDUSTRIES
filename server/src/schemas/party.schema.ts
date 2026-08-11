import { z } from 'zod';

export const partyTypeEnum = z.enum(['SUPPLIER', 'BUYER', 'BOTH', 'HAMALI_TEAM']);
/** Language this party's WhatsApp templates go out in - mirrors the WaLanguage enum. */
export const waLanguageEnum = z.enum(['EN', 'TE', 'TA', 'KN', 'HI']);
export const commodityEnum = z.enum(['BLACK_SEED', 'PAPPU', 'HUSK', 'TAMARIND_SHELL', 'TAMARIND_WASTE', 'TPS_BROKENS', 'PRECLEANER_DUST', 'NALLA_POKKULU', 'NALLA_CHINTAPANDU']);

export const createPartySchema = z.object({
  name: z.string().min(1, 'Name is required'),
  nickname: z.string().optional(),
  type: partyTypeEnum.default('SUPPLIER'),
  phone: z.string().optional(),
  phone2: z.string().optional(),
  email: z.string().email('Invalid email address').optional().or(z.literal('')),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  pincode: z.string().optional(),
  gstin: z.string().optional(),
  destination: z.string().optional(),
  locationLink: z.string().optional(),
  // Buyers only - turns the Surya Road Lines lorry receipt (GC) on for their shipments.
  lorryReceiptEnabled: z.boolean().optional(),
  waLanguage: waLanguageEnum.optional(),
  bankAccountNumber: z.string().optional(),
  bankIfsc: z.string().optional(),
  bankName: z.string().optional(),
  commodities: z.array(commodityEnum).default([]),
});

export const updatePartySchema = createPartySchema.partial();

export type CreatePartyInput = z.infer<typeof createPartySchema>;
export type UpdatePartyInput = z.infer<typeof updatePartySchema>;
