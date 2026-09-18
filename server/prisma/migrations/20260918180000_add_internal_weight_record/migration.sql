-- CreateTable
CREATE TABLE "InternalWeightRecord" (
    "id" TEXT NOT NULL,
    "vehicleNumber" TEXT NOT NULL,
    "partyName" TEXT,
    "partyId" TEXT,
    "weightKg" INTEGER NOT NULL,
    "material" TEXT NOT NULL DEFAULT 'PAPPU',
    "weighedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "usedAt" TIMESTAMP(3),
    "saleDispatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InternalWeightRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InternalWeightRecord_saleDispatchId_key" ON "InternalWeightRecord"("saleDispatchId");

-- CreateIndex
CREATE INDEX "InternalWeightRecord_vehicleNumber_used_idx" ON "InternalWeightRecord"("vehicleNumber", "used");

-- CreateIndex
CREATE INDEX "InternalWeightRecord_partyName_used_idx" ON "InternalWeightRecord"("partyName", "used");

-- CreateIndex
CREATE INDEX "InternalWeightRecord_createdAt_idx" ON "InternalWeightRecord"("createdAt");

-- AddForeignKey
ALTER TABLE "InternalWeightRecord" ADD CONSTRAINT "InternalWeightRecord_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternalWeightRecord" ADD CONSTRAINT "InternalWeightRecord_saleDispatchId_fkey" FOREIGN KEY ("saleDispatchId") REFERENCES "SaleDispatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
