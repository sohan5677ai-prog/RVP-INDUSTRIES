import { z } from 'zod';

export const partyTypeEnum = z.enum(['SUPPLIER', 'BUYER', 'BOTH', 'HAMALI_TEAM']);
/** Language this party's WhatsApp templates go out in - mirrors the WaLanguage enum. */
export const waLanguageEnum = z.enum(['EN', 'TE', 'TA', 'KN', 'HI']);
/** Settings -> Wishes targeting only - mirrors the WishCategory enum. */
export const wishCategoryEnum = z.enum(['HINDU', 'MUSLIM', 'CHRISTIAN', 'OTHER']);
export const commodityEnum = z.enum(['BLACK_SEED', 'PAPPU', 'HUSK', 'TAMARIND_SHELL', 'TAMARIND_WASTE', 'TPS_BROKENS', 'PRECLEANER_DUST', 'NALLA_POKKULU', 'NALLA_CHINTAPANDU']);

export const balanceTypeEnum = z.enum(['DR', 'CR']);

export const partyAddressSchema = z.object({
  id: z.string().optional(),
  label: z.string().min(1, 'Label is required'),
  address: z.string().min(1, 'Address is required'),
  city: z.string().optional().nullable(),
  state: z.string().optional().nullable(),
  pincode: z.string().optional().nullable(),
  gstin: z.string().optional().nullable(),
  isDefault: z.boolean().optional().default(false),
});

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
  religion: wishCategoryEnum.optional().nullable(),
  openingBalance: z.coerce.number().min(0).default(0).optional(),
  openingBalanceType: balanceTypeEnum.default('CR').optional(),
  bankAccountNumber: z.string().optional(),
  bankIfsc: z.string().optional(),
  bankName: z.string().optional(),
  commodities: z.array(commodityEnum).default([]),
  addresses: z.array(partyAddressSchema).optional().default([]),
});

export const updatePartySchema = createPartySchema.partial();

export type CreatePartyInput = z.infer<typeof createPartySchema>;
export type UpdatePartyInput = z.infer<typeof updatePartySchema>;
