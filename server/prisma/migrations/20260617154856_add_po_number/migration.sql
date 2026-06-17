/*
  Warnings:

  - A unique constraint covering the columns `[poNumber]` on the table `PurchaseOrder` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "poNumber" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_poNumber_key" ON "PurchaseOrder"("poNumber");
