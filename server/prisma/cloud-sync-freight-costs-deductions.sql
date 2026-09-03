-- Cloud DB sync for Freight Costs, Additions & Expense Deductions
--
-- Adds support for:
--   - Custom overrides for Hamali and Kata on dispatches & purchases
--   - Custom retention on purchases
--   - Itemized extra costs / additions (freightAdditions: [{ label, amount }])
--   - Itemized expenses / deductions (freightDeductions: [{ label, amount }])
--
-- Safe & idempotent (IF NOT EXISTS).

ALTER TABLE "SaleDispatch" ADD COLUMN IF NOT EXISTS "customHamali" DECIMAL(12, 2);
ALTER TABLE "SaleDispatch" ADD COLUMN IF NOT EXISTS "customKata" DECIMAL(12, 2);
ALTER TABLE "SaleDispatch" ADD COLUMN IF NOT EXISTS "freightAdditions" JSONB;
ALTER TABLE "SaleDispatch" ADD COLUMN IF NOT EXISTS "freightDeductions" JSONB;

ALTER TABLE "Purchase" ADD COLUMN IF NOT EXISTS "customHamali" DECIMAL(12, 2);
ALTER TABLE "Purchase" ADD COLUMN IF NOT EXISTS "customKata" DECIMAL(12, 2);
ALTER TABLE "Purchase" ADD COLUMN IF NOT EXISTS "customRetention" DECIMAL(12, 2);
ALTER TABLE "Purchase" ADD COLUMN IF NOT EXISTS "freightAdditions" JSONB;
ALTER TABLE "Purchase" ADD COLUMN IF NOT EXISTS "freightDeductions" JSONB;
