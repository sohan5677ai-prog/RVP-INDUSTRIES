-- Add slipImageUrl to WeighbridgeTicket table
ALTER TABLE "WeighbridgeTicket" ADD COLUMN IF NOT EXISTS "slipImageUrl" TEXT;
