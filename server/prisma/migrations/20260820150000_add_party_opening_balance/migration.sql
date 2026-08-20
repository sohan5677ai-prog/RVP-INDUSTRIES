-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "BalanceType" AS ENUM ('DR', 'CR');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AlterTable
ALTER TABLE "Party" ADD COLUMN IF NOT EXISTS "openingBalance" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "Party" ADD COLUMN IF NOT EXISTS "openingBalanceType" "BalanceType" NOT NULL DEFAULT 'CR';
