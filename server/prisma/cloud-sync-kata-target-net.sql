-- Kata target net (Pappu). Idempotent; applied via `prisma db push`, kept as a fallback.
ALTER TABLE "WeighbridgeTicket" ADD COLUMN IF NOT EXISTS "targetNetKg" INTEGER;
ALTER TABLE "WeighbridgeTicket" ADD COLUMN IF NOT EXISTS "actualSecondWeightKg" INTEGER;
ALTER TABLE "WeighbridgeTicket" ADD COLUMN IF NOT EXISTS "actualNetWeightKg" INTEGER;
