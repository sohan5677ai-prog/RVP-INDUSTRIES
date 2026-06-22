-- Sales rework: per-product sales, 3-state status, dispatch/credit-note removed.

-- New product enum
CREATE TYPE "SaleProduct" AS ENUM ('PAPPU', 'HUSK', 'WASTE', 'TPS');

-- Drop the dispatch table (dispatch + credit-note scrapped)
DROP TABLE IF EXISTS "SaleDispatch";

-- SaleOrder: add product + GST
ALTER TABLE "SaleOrder"
  ADD COLUMN "product" "SaleProduct" NOT NULL DEFAULT 'PAPPU',
  ADD COLUMN "gstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- Swap SaleStatus enum: PENDING/DISPATCHED/COMPLETED/CANCELLED -> PENDING/DISPATCHED/REACHED
ALTER TYPE "SaleStatus" RENAME TO "SaleStatus_old";
CREATE TYPE "SaleStatus" AS ENUM ('PENDING', 'DISPATCHED', 'REACHED');
ALTER TABLE "SaleOrder" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "SaleOrder" ALTER COLUMN "status" TYPE "SaleStatus" USING (
  CASE "status"::text
    WHEN 'COMPLETED' THEN 'REACHED'
    WHEN 'CANCELLED' THEN 'PENDING'
    ELSE "status"::text
  END::"SaleStatus"
);
ALTER TABLE "SaleOrder" ALTER COLUMN "status" SET DEFAULT 'PENDING';
DROP TYPE "SaleStatus_old";
