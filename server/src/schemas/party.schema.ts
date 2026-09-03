import { z } from 'zod';

export const partyTypeEnum = z.enum(['SUPPLIER', 'BUYER', 'BOTH', 'HAMALI_TEAM']);
/** Language this party's WhatsApp templates go out in - mirrors the WaLanguage enum. */
export const waLanguageEnum = z.enum(['EN', 'TE', 'TA', 'KN', 'HI']);
/** Settings -> Wishes targeting only - mirrors the WishCategory enum. */
export const wishCategoryEnum = z.enum(['HINDU', 'MUSLIM', 'CHRISTIAN', 'OTHER']);
export const commodityEnum = z.enum(['BLACK_SEED', 'PAPPU', 'HUSK', 'TAMARIND_SHELL', 'TAMARIND_WASTE', 'TPS_BROKENS', 'PRECLEANER_DUST', 'NALLA_POKKULU', 'NALLA_CHINTAPANDU']);

export const balanceTypeEnum = z.enum(['DR', 'CR']);

export const partyAddressSchema = z.object({
  id: z.string().optional().nullable(),
  label: z.string().optional().nullable().transform((v) => (v && v.trim()) || 'Registered Office'),
  address: z.string().optional().nullable().transform((v) => (v && v.trim()) || ''),
  city: z.string().optional().nullable(),
  state: z.string().optional().nullable(),
  pincode: z.string().optional().nullable(),
  gstin: z.string().optional().nullable(),
  destination: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  phone2: z.string().optional().nullable(),
  locationLink: z.string().optional().nullable(),
  isDefault: z.boolean().optional().default(false),
});

export const createPartySchema = z.object({
  name: z.string().min(1, 'Name is required'),
  nickname: z.string().optional().nullable(),
  type: partyTypeEnum.default('SUPPLIER'),
  phone: z.string().optional().nullable(),
  phone2: z.string().optional().nullable(),
  email: z.string().email('Invalid email address').optional().nullable().or(z.literal('')).or(z.literal(null)),
  address: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  state: z.string().optional().nullable(),
  pincode: z.string().optional().nullable(),
  gstin: z.string().optional().nullable(),
  destination: z.string().optional().nullable(),
  locationLink: z.string().optional().nullable(),
  // Buyers only - turns the Surya Road Lines lorry receipt (GC) on for their shipments.
  lorryReceiptEnabled: z.boolean().optional().default(false),
  waLanguage: waLanguageEnum.optional().default('EN'),
  religion: wishCategoryEnum.optional().nullable(),
  openingBalance: z.preprocess(
    (val) => (val === '' || val === null || val === undefined ? 0 : val),
    z.coerce.number().min(0).default(0)
  ).optional(),
  openingBalanceType: z.preprocess(
    (val) => (val === null || val === undefined || val === '' ? 'CR' : val),
    balanceTypeEnum.default('CR')
  ).optional(),
  bankAccountNumber: z.string().optional().nullable(),
  bankIfsc: z.string().optional().nullable(),
  bankName: z.string().optional().nullable(),
  commodities: z.array(commodityEnum).optional().default([]),
  addresses: z.array(partyAddressSchema).optional().default([]),
});

export const updatePartySchema = createPartySchema.partial();

export type CreatePartyInput = z.infer<typeof createPartySchema>;
export type UpdatePartyInput = z.infer<typeof updatePartySchema>;
