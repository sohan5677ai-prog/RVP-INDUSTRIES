-- ============================================================================
-- Cloud Database Sync: Transport Community (Religion Tag) & Wishes Integration
-- ============================================================================

DO $$
BEGIN
  -- 1. Ensure 'WishCategory' enum exists
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WishCategory') THEN
    CREATE TYPE "WishCategory" AS ENUM ('HINDU', 'MUSLIM', 'CHRISTIAN', 'OTHER');
  END IF;

  -- 2. Add 'religion' column to "Transport" table
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Transport' AND column_name = 'religion'
  ) THEN
    ALTER TABLE "Transport" ADD COLUMN "religion" "WishCategory";
  END IF;

  -- 3. Add 'includeTransports' column to "WishBroadcast" table
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'WishBroadcast' AND column_name = 'includeTransports'
  ) THEN
    ALTER TABLE "WishBroadcast" ADD COLUMN "includeTransports" BOOLEAN NOT NULL DEFAULT true;
  END IF;
END $$;
