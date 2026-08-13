import { z } from 'zod';
import { RECEIPT_TYPES } from '../services/ledger.service.js';

// No paise anywhere in the ERP: money inputs are rounded to whole rupees on entry.
const wholeRupee = z.coerce.number().transform((v) => Math.round(v));

// One invoice's share of a single collection. A buyer usually clears several
// bills with one transfer, but settlement everywhere else is invoice-based
// (a shipment is cleared only by receipts carrying its own dispatch id), so the
// collection is split into one Receipt row per invoice rather than left floating.
const receiptAllocationSchema = z.object({
  saleDispatchId: z.string().min(1),
  amount: wholeRupee.pipe(z.number().min(0)),
  tdsAmount: wholeRupee.pipe(z.number().min(0)).optional().default(0),
  shortageAmount: wholeRupee.pipe(z.number().min(0)).optional().default(0),
});

export const createReceiptSchema = z.object({
  date: z.coerce.date(),
  amount: wholeRupee.pipe(z.number().min(0)),
  tdsAmount: wholeRupee.pipe(z.number().min(0)).optional().nullable(),
  shortageAmount: wholeRupee.pipe(z.number().min(0)).optional().nullable(),
  type: z.enum(RECEIPT_TYPES),
  partyId: z.string().optional().nullable(),
  saleDispatchId: z.string().optional().nullable(),
  payer: z.string().optional().nullable(),
  reference: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  // Optional bill-wise split. When present it supersedes the single
  // saleDispatchId/tdsAmount/shortageAmount fields.
  allocations: z.array(receiptAllocationSchema).optional(),
});

export type CreateReceiptInput = z.infer<typeof createReceiptSchema>;

// Correcting a receipt already on the books. It carries the same invoice /
// TDS / shortage fields as a fresh collection, so a correction can restate the
// deductions the buyer actually took - and can apply money that was parked on
// account to the bill it covers. What it can NEVER do is move an already-applied
// receipt to a different bill; the controller enforces that. A correction
// rewrites one row, so there is no multi-invoice split here.
export const updateReceiptSchema = createReceiptSchema.omit({ allocations: true });

export type UpdateReceiptInput = z.infer<typeof updateReceiptSchema>;

export const listReceiptsSchema = z.object({
  skip: z.coerce.number().int().nonnegative().optional(),
  take: z.coerce.number().int().positive().optional().default(100),
  all: z.enum(['true', 'false']).optional()
});
