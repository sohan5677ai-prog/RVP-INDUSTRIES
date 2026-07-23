-- WhatsApp: internal-alert distribution list (Settings → WhatsApp).
-- Adds CompanyProfile.alertRecipients, a JSON string of up to 3 members
-- [{ "name": "...", "phone": "..." }] who receive dispatch reminders, the
-- weekly summary and the daily dues digest.
-- Idempotent and additive: safe to run more than once.
ALTER TABLE "CompanyProfile"
  ADD COLUMN IF NOT EXISTS "alertRecipients" TEXT;
