-- Cloud DB sync for the TDS / shortage / receipt-against-invoice features
-- (commits 2809941, 127b6ec, 95d35d0 — dispatch date, delivered date, receipt
-- shortage picker, TDS toggle, and TDS/shortage on the party ledger).
--
-- Background: the cloud Supabase DB is a pg_restore mirror and Render boots
-- `npm start` only (no `prisma migrate deploy`), so columns added locally via
-- `prisma db push` never reached it. The deployed backend then SELECTs columns
-- the cloud DB doesn't have, which 500s three pages at once:
--   • Receipts register  → prisma.receipt.findMany() selects the missing
--                          tdsAmount / shortageAmount / saleDispatchId columns
--   • Party ledger       → listPartyLedgers raw SQL references r."tdsAmount",
--                          r."shortageAmount", r."saleDispatchId", sd."tdsAmount"
--   • Sale Dues "Received" / Sales "Mark as Paid" → both write those columns
--
-- Safe to run: every statement is additive and idempotent (IF NOT EXISTS /
-- duplicate-object guards), so re-running it is a no-op and columns that already
-- exist on cloud are left untouched. No data is modified.
--
-- Run this in the Supabase SQL Editor (project → SQL Editor → New query → Run).

-- 1. Receipt: buyer TDS / shortage deductions + link to a specific dispatch -----
ALTER TABLE "Receipt" ADD COLUMN IF NOT EXISTS "tdsAmount"      DECIMAL(12,2);
ALTER TABLE "Receipt" ADD COLUMN IF NOT EXISTS "shortageAmount" DECIMAL(12,2);
ALTER TABLE "Receipt" ADD COLUMN IF NOT EXISTS "saleDispatchId" TEXT;

CREATE INDEX IF NOT EXISTS "Receipt_saleDispatchId_idx"
    ON "Receipt"("saleDispatchId");

DO $$ BEGIN
  ALTER TABLE "Receipt"
    ADD CONSTRAINT "Receipt_saleDispatchId_fkey"
    FOREIGN KEY ("saleDispatchId") REFERENCES "SaleDispatch"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- 2. SaleDispatch: TDS + delivery-matching / kata columns ----------------------
--    (tdsAmount + deliveredDate are the ones the new code reads/writes; the rest
--     are included for completeness so the dispatch table matches the schema.)
ALTER TABLE "SaleDispatch" ADD COLUMN IF NOT EXISTS "tdsAmount"        DECIMAL(12,2);
ALTER TABLE "SaleDispatch" ADD COLUMN IF NOT EXISTS "deliveredDate"    TIMESTAMP(3);
ALTER TABLE "SaleDispatch" ADD COLUMN IF NOT EXISTS "receivedDate"     TIMESTAMP(3);
ALTER TABLE "SaleDispatch" ADD COLUMN IF NOT EXISTS "buyerKataKg"      INTEGER;
ALTER TABLE "SaleDispatch" ADD COLUMN IF NOT EXISTS "shortageKg"       INTEGER;
ALTER TABLE "SaleDispatch" ADD COLUMN IF NOT EXISTS "creditNoteAmount" DECIMAL(12,2);
ALTER TABLE "SaleDispatch" ADD COLUMN IF NOT EXISTS "buyerKataFileUrl" TEXT;
ALTER TABLE "SaleDispatch" ADD COLUMN IF NOT EXISTS "transportProvider" TEXT;
ALTER TABLE "SaleDispatch" ADD COLUMN IF NOT EXISTS "customRetention"  DECIMAL(12,2);
