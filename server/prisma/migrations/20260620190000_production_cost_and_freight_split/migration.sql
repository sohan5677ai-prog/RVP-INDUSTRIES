-- Configurable per-trip freight retention + user-defined production cost components.

ALTER TABLE "CompanyProfile" ADD COLUMN "freightRetentionPerTrip" DECIMAL(12,2) NOT NULL DEFAULT 3000;

CREATE TABLE "ProductionCostComponent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ratePerKg" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductionCostComponent_pkey" PRIMARY KEY ("id")
);
