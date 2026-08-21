-- CreateTable
CREATE TABLE IF NOT EXISTS "PartyAddress" (
    "id" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "city" TEXT,
    "state" TEXT,
    "pincode" TEXT,
    "gstin" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartyAddress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PartyAddress_partyId_idx" ON "PartyAddress"("partyId");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "PartyAddress" ADD CONSTRAINT "PartyAddress_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AlterTable SaleOrder
ALTER TABLE "SaleOrder" ADD COLUMN IF NOT EXISTS "poNumber" TEXT;
ALTER TABLE "SaleOrder" ADD COLUMN IF NOT EXISTS "poDate" TIMESTAMP(3);
ALTER TABLE "SaleOrder" ADD COLUMN IF NOT EXISTS "buyerAddressId" TEXT;
ALTER TABLE "SaleOrder" ADD COLUMN IF NOT EXISTS "buyerAddress" TEXT;
ALTER TABLE "SaleOrder" ADD COLUMN IF NOT EXISTS "buyerCity" TEXT;
ALTER TABLE "SaleOrder" ADD COLUMN IF NOT EXISTS "buyerState" TEXT;
ALTER TABLE "SaleOrder" ADD COLUMN IF NOT EXISTS "buyerPincode" TEXT;
ALTER TABLE "SaleOrder" ADD COLUMN IF NOT EXISTS "buyerGstin" TEXT;

-- Backfill: For existing parties that have an address, insert an initial "Registered Office" PartyAddress as default
INSERT INTO "PartyAddress" ("id", "partyId", "label", "address", "city", "state", "pincode", "gstin", "isDefault", "createdAt", "updatedAt")
SELECT
    'addr_' || substr(md5(random()::text || "id"), 1, 20),
    "id",
    'Registered Office',
    COALESCE("address", "city", 'Registered Address'),
    "city",
    "state",
    "pincode",
    "gstin",
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Party" p
WHERE ("address" IS NOT NULL AND TRIM("address") <> '')
  AND NOT EXISTS (SELECT 1 FROM "PartyAddress" pa WHERE pa."partyId" = p."id");
