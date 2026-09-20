-- Add weighbridgeTicketId to StockIn table and link to WeighbridgeTicket
ALTER TABLE "StockIn" ADD COLUMN IF NOT EXISTS "weighbridgeTicketId" TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'StockIn_weighbridgeTicketId_fkey'
    ) THEN
        ALTER TABLE "StockIn" ADD CONSTRAINT "StockIn_weighbridgeTicketId_fkey"
        FOREIGN KEY ("weighbridgeTicketId") REFERENCES "WeighbridgeTicket"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "StockIn_weighbridgeTicketId_idx" ON "StockIn"("weighbridgeTicketId");
