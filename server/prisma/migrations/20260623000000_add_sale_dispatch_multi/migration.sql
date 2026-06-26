-- Multi-dispatch sales: each order can ship in several lorries. A new SaleDispatch
-- child table carries the per-lorry weight, ledger posting, tax invoice and
-- delivery/shortage. SaleStatus gains PARTIAL (some dispatched) and drops REACHED
-- (the reached step is merged into delivery).

-- 1. Collapse legacy REACHED orders to DISPATCHED before swapping the enum.
UPDATE "SaleOrder" SET "status" = 'DISPATCHED' WHERE "status" = 'REACHED';

-- 2. Swap SaleStatus enum: PENDING/DISPATCHED/REACHED/DELIVERED -> PENDING/PARTIAL/DISPATCHED/DELIVERED
ALTER TYPE "SaleStatus" RENAME TO "SaleStatus_old";
CREATE TYPE "SaleStatus" AS ENUM ('PENDING', 'PARTIAL', 'DISPATCHED', 'DELIVERED');
ALTER TABLE "SaleOrder" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "SaleOrder" ALTER COLUMN "status" TYPE "SaleStatus" USING ("status"::text::"SaleStatus");
ALTER TABLE "SaleOrder" ALTER COLUMN "status" SET DEFAULT 'PENDING';
DROP TYPE "SaleStatus_old";

-- 3. Move the invoice-number unique index off SaleOrder (now lives on SaleDispatch).
DROP INDEX IF EXISTS "SaleOrder_invoiceFy_invoiceSeq_key";

-- 4. Create the SaleDispatch table.
CREATE TABLE "SaleDispatch" (
    "id" TEXT NOT NULL,
    "saleOrderId" TEXT NOT NULL,
    "dispatchDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "weightKg" INTEGER NOT NULL,
    "gstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "freightCharge" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" "SaleStatus" NOT NULL DEFAULT 'DISPATCHED',
    "vehicleNumber" TEXT,
    "kataFileUrl" TEXT,
    "receivedDate" TIMESTAMP(3),
    "deliveredDate" TIMESTAMP(3),
    "buyerKataKg" INTEGER,
    "shortageKg" INTEGER,
    "creditNoteAmount" DECIMAL(12,2),
    "buyerKataFileUrl" TEXT,
    "invoiceNumber" TEXT,
    "invoiceSeq" INTEGER,
    "invoiceFy" TEXT,
    "invoiceDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SaleDispatch_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SaleDispatch_saleOrderId_idx" ON "SaleDispatch"("saleOrderId");
CREATE UNIQUE INDEX "SaleDispatch_invoiceFy_invoiceSeq_key" ON "SaleDispatch"("invoiceFy", "invoiceSeq");
ALTER TABLE "SaleDispatch" ADD CONSTRAINT "SaleDispatch_saleOrderId_fkey" FOREIGN KEY ("saleOrderId") REFERENCES "SaleOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5. Backfill: every already-dispatched order becomes one dispatch carrying its
--    legacy dispatch/invoice/delivery fields. The order's ordered weight is kept
--    as-is (historically it equals the dispatched weight). Old ledger references
--    (SALE-<orderId>) remain valid history and are left untouched.
INSERT INTO "SaleDispatch" (
  "id","saleOrderId","dispatchDate","weightKg","gstAmount","freightCharge","status",
  "vehicleNumber","kataFileUrl","receivedDate","deliveredDate","buyerKataKg","shortageKg",
  "creditNoteAmount","buyerKataFileUrl","invoiceNumber","invoiceSeq","invoiceFy","invoiceDate","createdAt"
)
SELECT
  'sd_' || "id",
  "id",
  "saleDate",
  "tonnageKg",
  "gstAmount",
  "freightCharge",
  CASE WHEN "deliveredDate" IS NOT NULL THEN 'DELIVERED'::"SaleStatus" ELSE 'DISPATCHED'::"SaleStatus" END,
  "vehicleNumber","kataFileUrl","receivedDate","deliveredDate",NULL,NULL,
  NULL,NULL,"invoiceNumber","invoiceSeq","invoiceFy","invoiceDate","createdAt"
FROM "SaleOrder"
WHERE "status" <> 'PENDING';

-- All backfilled orders are fully dispatched (one dispatch = the whole order).
UPDATE "SaleOrder" SET "status" = 'DISPATCHED' WHERE "status" <> 'PENDING';
