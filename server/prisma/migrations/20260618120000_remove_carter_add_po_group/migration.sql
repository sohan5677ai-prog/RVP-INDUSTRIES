-- Remove carter freight from the domain
ALTER TABLE "Purchase" DROP COLUMN IF EXISTS "carterCharge";
ALTER TABLE "StockIn" DROP COLUMN IF EXISTS "carterDistanceKm";

-- Add a group id so per-lorry POs created from one order can be grouped together
ALTER TABLE "PurchaseOrder" ADD COLUMN "poGroupId" TEXT;

-- Backfill existing rows so each existing PO groups on its own
UPDATE "PurchaseOrder" SET "poGroupId" = "id" WHERE "poGroupId" IS NULL;
