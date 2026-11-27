-- Cloud DB sync: Pappu Transfer (Mill -> Storage) hamali charge, Rs 270/t.
-- Adds the enum value and the per-tonne columns on ManualHamaliCost.
-- Safe and idempotent: re-running is a no-op. Equivalent to `npx prisma db push`.
-- Run in Supabase SQL Editor if db push can't reach the database.

ALTER TYPE "ManualHamaliType" ADD VALUE IF NOT EXISTS 'PAPPU_TRANSFER';

ALTER TABLE "ManualHamaliCost" ADD COLUMN IF NOT EXISTS "weightKg" INTEGER;
ALTER TABLE "ManualHamaliCost" ADD COLUMN IF NOT EXISTS "ratePerTonne" DECIMAL(8,2);

-- Pappu Stock page: where each Pappu Transfer went, and on which lorry.
ALTER TABLE "ManualHamaliCost" ADD COLUMN IF NOT EXISTS "toLocation" TEXT;
ALTER TABLE "ManualHamaliCost" ADD COLUMN IF NOT EXISTS "lorryNumber" TEXT;
