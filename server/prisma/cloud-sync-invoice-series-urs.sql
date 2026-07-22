-- Cloud DB sync for the Un-Registered Sales (URS) invoice series.
--
-- Background: the cloud Supabase DB is a pg_restore mirror and Render boots
-- `npm start` only (no `prisma migrate deploy`), so a column added locally via
-- `prisma db push` never reaches it. The deployed backend then reads/writes the
-- missing column and 500s every sale-dispatch read + the invoice-raise action.
--
-- What this adds: SaleDispatch.invoiceSeries separates the invoice-number pools.
-- "RVP" = the regular registered tax invoices (RVP/01/26-27); "URS" = Un-Registered
-- Sales (URS/01/26-27). Each series keeps its own running sequence per financial
-- year, so the invoice-number uniqueness is now (invoiceFy, invoiceSeq, invoiceSeries).
--
-- Existing rows all backfill to 'RVP' via the column DEFAULT, so the old
-- (invoiceFy, invoiceSeq) uniqueness is preserved and the new 3-column key cannot
-- collide.
--
-- Safe to run: additive + idempotent, so re-running is a no-op.
-- Run this in the Supabase SQL Editor (project → SQL Editor → New query → Run).

-- 1. Series column (backfills every existing row to 'RVP').
ALTER TABLE "SaleDispatch"
  ADD COLUMN IF NOT EXISTS "invoiceSeries" TEXT NOT NULL DEFAULT 'RVP';

-- 2. Swap the invoice-number uniqueness to include the series.
ALTER TABLE "SaleDispatch"
  DROP CONSTRAINT IF EXISTS "SaleDispatch_invoiceFy_invoiceSeq_key";

ALTER TABLE "SaleDispatch"
  DROP CONSTRAINT IF EXISTS "SaleDispatch_invoiceFy_invoiceSeq_invoiceSeries_key";
ALTER TABLE "SaleDispatch"
  ADD CONSTRAINT "SaleDispatch_invoiceFy_invoiceSeq_invoiceSeries_key"
  UNIQUE ("invoiceFy", "invoiceSeq", "invoiceSeries");
