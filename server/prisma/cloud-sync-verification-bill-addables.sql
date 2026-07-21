-- Cloud DB sync for the Verification "Bill Addables" feature.
--
-- Background: the cloud Supabase DB is a pg_restore mirror and Render boots
-- `npm start` only (no `prisma migrate deploy`), so a column added locally via
-- `prisma db push` never reaches it. The deployed backend then reads/writes the
-- missing column and 500s the Verification approval + list.
--
-- billAddables holds the extra costs itemised at approval as a JSON array of
-- { label, amount }. Each addable adds to the supplier's net payable and
-- capitalises into the seed's landed cost (totalAmount already includes the
-- addables total, so the ledger and silo MAP stay balanced).
--
-- Safe to run: additive + idempotent (IF NOT EXISTS), so re-running is a no-op.
-- Run this in the Supabase SQL Editor (project → SQL Editor → New query → Run).

ALTER TABLE "WeightVerification" ADD COLUMN IF NOT EXISTS "billAddables" JSONB;
