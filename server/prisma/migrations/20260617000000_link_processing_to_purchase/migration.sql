-- AlterTable
ALTER TABLE "Processing" ADD COLUMN     "purchaseId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Processing_purchaseId_key" ON "Processing"("purchaseId");

-- AddForeignKey
ALTER TABLE "Processing" ADD CONSTRAINT "Processing_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;
