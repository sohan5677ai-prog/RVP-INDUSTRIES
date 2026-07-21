-- WhatsApp test-mode UI toggle (Settings → WhatsApp).
-- Adds the two CompanyProfile columns that back the toggle + test number.
-- Idempotent and additive: safe to run more than once.
ALTER TABLE "CompanyProfile"
  ADD COLUMN IF NOT EXISTS "whatsappTestMode" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "CompanyProfile"
  ADD COLUMN IF NOT EXISTS "whatsappTestNumber" TEXT;
