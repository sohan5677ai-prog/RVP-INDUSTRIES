-- Link automatically-created inventory movements back to their Kata ticket.
-- The unique indexes make second-weight retries idempotent.
ALTER TABLE "StockTransfer" ADD COLUMN "weighbridgeTicketId" TEXT;
ALTER TABLE "HuskTransfer" ADD COLUMN "weighbridgeTicketId" TEXT;
ALTER TABLE "ShellTransfer" ADD COLUMN "weighbridgeTicketId" TEXT;
ALTER TABLE "ShellTransfer" ADD COLUMN "material" TEXT NOT NULL DEFAULT 'TAMARIND SHELL';

CREATE UNIQUE INDEX "StockTransfer_weighbridgeTicketId_key"
  ON "StockTransfer"("weighbridgeTicketId");
CREATE UNIQUE INDEX "HuskTransfer_weighbridgeTicketId_key"
  ON "HuskTransfer"("weighbridgeTicketId");
CREATE UNIQUE INDEX "ShellTransfer_weighbridgeTicketId_key"
  ON "ShellTransfer"("weighbridgeTicketId");
