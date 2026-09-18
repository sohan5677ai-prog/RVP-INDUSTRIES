ALTER TABLE "WeighbridgeTicket"
  ADD COLUMN "isStorageTransfer" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "storageLocation" TEXT,
  ADD COLUMN "transferDirection" TEXT;

CREATE INDEX "WeighbridgeTicket_storageTransfer_idx"
  ON "WeighbridgeTicket"("isStorageTransfer", "storageLocation");
