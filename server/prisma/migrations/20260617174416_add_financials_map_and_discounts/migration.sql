-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');

-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('WEIGHT', 'PRICE', 'AMOUNT');

-- AlterTable
ALTER TABLE "Processing" ADD COLUMN     "huskWeightKg" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "loadingLocation" TEXT NOT NULL DEFAULT 'At process',
ADD COLUMN     "lostWeightKg" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "overheadElectricity" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "overheadMaintenance" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "overheadWages" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "wasteWeightKg" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Purchase" ADD COLUMN     "carterCharge" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "discountType" "DiscountType",
ADD COLUMN     "discountValue" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "SaleDispatch" ADD COLUMN     "buyerWeightKg" INTEGER,
ADD COLUMN     "creditNoteAmount" DECIMAL(12,2),
ADD COLUMN     "creditNoteReason" TEXT;

-- AlterTable
ALTER TABLE "SaleOrder" ADD COLUMN     "marginOverride" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "StockIn" ADD COLUMN     "carterDistanceKm" INTEGER NOT NULL DEFAULT 50;

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AccountType" NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "reference" TEXT,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalLine" (
    "id" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "debit" DECIMAL(12,2) NOT NULL,
    "credit" DECIMAL(12,2) NOT NULL,
    "costCenter" TEXT,

    CONSTRAINT "JournalLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiloInventory" (
    "id" TEXT NOT NULL,
    "itemType" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "weightKg" INTEGER NOT NULL DEFAULT 0,
    "totalValue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiloInventory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_code_key" ON "Account"("code");

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
