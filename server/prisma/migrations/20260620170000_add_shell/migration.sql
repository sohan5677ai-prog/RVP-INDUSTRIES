-- Tamarind Shell: new sale product + process→Rampalli shell transfers.

-- New SaleProduct value (not used elsewhere in this migration, so safe in-tx).
ALTER TYPE "SaleProduct" ADD VALUE IF NOT EXISTS 'SHELL';

-- CreateTable: ShellTransfer
CREATE TABLE "ShellTransfer" (
    "id" TEXT NOT NULL,
    "fromLocation" TEXT NOT NULL DEFAULT 'At process',
    "toLocation" TEXT NOT NULL DEFAULT 'Rampalli',
    "weightKg" INTEGER NOT NULL,
    "lorryNumber" TEXT,
    "hamaliCharge" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "transportCharge" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "transferDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShellTransfer_pkey" PRIMARY KEY ("id")
);
