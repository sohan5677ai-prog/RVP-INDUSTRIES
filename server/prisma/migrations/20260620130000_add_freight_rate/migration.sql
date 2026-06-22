-- Editable per-destination outward freight rates.
CREATE TABLE "FreightRate" (
    "id" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "ratePerTonne" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FreightRate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FreightRate_destination_key" ON "FreightRate"("destination");
