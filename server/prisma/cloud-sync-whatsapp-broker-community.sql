-- WhatsApp / Wishes: Broker community tagging and inclusion in wishes broadcast.
-- Adds Broker.religion (WishCategory) and WishBroadcast.includeBrokers.
-- Idempotent and additive: safe to run more than once.

ALTER TABLE "Broker"
  ADD COLUMN IF NOT EXISTS "religion" "WishCategory";

ALTER TABLE "WishBroadcast"
  ADD COLUMN IF NOT EXISTS "includeBrokers" BOOLEAN NOT NULL DEFAULT true;
