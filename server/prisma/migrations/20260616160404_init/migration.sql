-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'MANAGER', 'OPERATOR');

-- CreateEnum
CREATE TYPE "PartyType" AS ENUM ('SUPPLIER', 'BUYER', 'BOTH');

-- CreateEnum
CREATE TYPE "POStatus" AS ENUM ('PENDING', 'ARRIVED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SaleStatus" AS ENUM ('PENDING', 'DISPATCHED', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'OPERATOR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Party" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PartyType" NOT NULL DEFAULT 'SUPPLIER',
    "phone" TEXT,
    "address" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Party_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Broker" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,

    CONSTRAINT "Broker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "poDate" TIMESTAMP(3) NOT NULL,
    "partyId" TEXT NOT NULL,
    "pricePerKg" DECIMAL(12,2) NOT NULL,
    "tonnageKg" INTEGER NOT NULL,
    "lorryCount" INTEGER,
    "status" "POStatus" NOT NULL DEFAULT 'PENDING',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockIn" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "arrivalDate" TIMESTAMP(3) NOT NULL,
    "lorryNumber" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "rvpKataKg" INTEGER NOT NULL,
    "billingWeightKg" INTEGER NOT NULL,
    "partyKataKg" INTEGER NOT NULL,
    "invoiceFileUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockIn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Purchase" (
    "id" TEXT NOT NULL,
    "stockInId" TEXT NOT NULL,
    "netWeightKg" INTEGER NOT NULL,
    "hamaliRate" DECIMAL(8,2) NOT NULL DEFAULT 80,
    "hamaliCharge" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Purchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeightVerification" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "billingWeightKg" INTEGER NOT NULL,
    "partyKataKg" INTEGER NOT NULL,
    "rvpKataKg" INTEGER NOT NULL,
    "referenceKg" INTEGER NOT NULL,
    "diffKg" INTEGER NOT NULL,
    "exempt" BOOLEAN NOT NULL,
    "finalWeightKg" INTEGER NOT NULL,
    "pricePerKg" DECIMAL(12,2) NOT NULL,
    "totalAmount" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WeightVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Processing" (
    "id" TEXT NOT NULL,
    "blackWeightKg" INTEGER NOT NULL,
    "outTurnPct" DECIMAL(5,2) NOT NULL DEFAULT 60,
    "pappuWeightKg" INTEGER NOT NULL,
    "processDate" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Processing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PappuPrice" (
    "id" TEXT NOT NULL,
    "processingId" TEXT NOT NULL,
    "pricePerKg" DECIMAL(12,2) NOT NULL,
    "pricedDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PappuPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleOrder" (
    "id" TEXT NOT NULL,
    "saleDate" TIMESTAMP(3) NOT NULL,
    "buyerId" TEXT NOT NULL,
    "brokerId" TEXT,
    "tonnageKg" INTEGER NOT NULL,
    "ratePerKg" DECIMAL(12,2) NOT NULL,
    "status" "SaleStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaleOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleDispatch" (
    "id" TEXT NOT NULL,
    "saleOrderId" TEXT NOT NULL,
    "invoiceFileUrl" TEXT NOT NULL,
    "dispatchWeightKg" INTEGER NOT NULL,
    "dispatchDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaleDispatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "StockIn_purchaseOrderId_key" ON "StockIn"("purchaseOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Purchase_stockInId_key" ON "Purchase"("stockInId");

-- CreateIndex
CREATE UNIQUE INDEX "WeightVerification_purchaseId_key" ON "WeightVerification"("purchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "PappuPrice_processingId_key" ON "PappuPrice"("processingId");

-- CreateIndex
CREATE UNIQUE INDEX "SaleDispatch_saleOrderId_key" ON "SaleDispatch"("saleOrderId");

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockIn" ADD CONSTRAINT "StockIn_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_stockInId_fkey" FOREIGN KEY ("stockInId") REFERENCES "StockIn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeightVerification" ADD CONSTRAINT "WeightVerification_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PappuPrice" ADD CONSTRAINT "PappuPrice_processingId_fkey" FOREIGN KEY ("processingId") REFERENCES "Processing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleOrder" ADD CONSTRAINT "SaleOrder_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "Party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleOrder" ADD CONSTRAINT "SaleOrder_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "Broker"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleDispatch" ADD CONSTRAINT "SaleDispatch_saleOrderId_fkey" FOREIGN KEY ("saleOrderId") REFERENCES "SaleOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

