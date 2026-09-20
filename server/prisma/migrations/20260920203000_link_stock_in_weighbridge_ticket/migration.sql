-- AlterTable
ALTER TABLE "StockIn" ADD COLUMN "weighbridgeTicketId" TEXT;

-- CreateIndex
CREATE INDEX "StockIn_weighbridgeTicketId_idx" ON "StockIn"("weighbridgeTicketId");

-- AddForeignKey
ALTER TABLE "StockIn" ADD CONSTRAINT "StockIn_weighbridgeTicketId_fkey" FOREIGN KEY ("weighbridgeTicketId") REFERENCES "WeighbridgeTicket"("id") ON DELETE SET NULL ON UPDATE CASCADE;
