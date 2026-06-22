-- Bag-cutting (bunker pour) + storage→process transfers.

-- CreateEnum
CREATE TYPE "BunkerPlace" AS ENUM ('A', 'B');

-- AlterTable: Purchase gains bunker place + bag-cutting fields
ALTER TABLE "Purchase"
  ADD COLUMN "bunkerPlace" "BunkerPlace",
  ADD COLUMN "bagCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "bagCuttingCharge" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- CreateTable: StockTransfer
CREATE TABLE "StockTransfer" (
    "id" TEXT NOT NULL,
    "fromLocation" TEXT NOT NULL,
    "toLocation" TEXT NOT NULL DEFAULT 'At process',
    "weightKg" INTEGER NOT NULL,
    "lorryNumber" TEXT,
    "transportCharge" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "loadingHamali" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "unloadingHamali" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "bunkerPlace" "BunkerPlace",
    "bagCount" INTEGER NOT NULL DEFAULT 0,
    "bagCuttingCharge" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "hamaliMargin" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "seedCostMoved" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "movedValue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "transferDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockTransfer_pkey" PRIMARY KEY ("id")
);
