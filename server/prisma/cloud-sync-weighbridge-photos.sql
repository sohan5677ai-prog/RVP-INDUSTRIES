-- Cloud DB sync for Weighbridge Ticket Camera Snapshots
-- Safe to run: idempotent additive column creation
ALTER TABLE "WeighbridgeTicket"
  ADD COLUMN IF NOT EXISTS "cam1PhotoUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "cam2PhotoUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "secondCam1PhotoUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "secondCam2PhotoUrl" TEXT;
