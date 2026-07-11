import { z } from 'zod';

/** A single ledger line as parsed from a Tally voucher. */
const ledgerLineSchema = z.object({
  ledgerName: z.string(),
  amount: z.number(),
  isDeemedPositive: z.boolean(),
});

/** A parsed Tally voucher as the office-PC agent sends it up. */
export const tallyVoucherSchema = z.object({
  guid: z.string().min(1),
  alterId: z.number().int().nonnegative(),
  voucherType: z.string(),
  voucherNumber: z.string().default(''),
  date: z.string(),
  narration: z.string().default(''),
  isCancelled: z.boolean().default(false),
  lines: z.array(ledgerLineSchema).default([]),
});

export const tallySyncSchema = z.object({
  vouchers: z.array(tallyVoucherSchema),
});

export const tallyMapSchema = z.object({
  ledgerName: z.string().min(1),
  partyId: z.string().min(1),
  note: z.string().optional(),
});
