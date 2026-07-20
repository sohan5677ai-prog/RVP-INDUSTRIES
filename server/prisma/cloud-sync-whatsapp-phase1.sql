-- Cloud DB sync for commit 4116094 (WhatsApp Phase 1).
-- The cloud Supabase DB is a pg_restore mirror and Render boots `npm start`
-- only (no migrate deploy), so schema changes made locally via `prisma db push`
-- never reached it. This brings the cloud DB up to the committed schema.
--
-- Safe to run: every statement is additive and idempotent (IF NOT EXISTS /
-- duplicate-object guards), so re-running it is a no-op. No data is modified.
--
-- Run this in the Supabase SQL Editor (project → SQL Editor → New query → Run).

-- 1. New columns on existing tables ------------------------------------------
ALTER TABLE "Party"        ADD COLUMN IF NOT EXISTS "locationLink"  TEXT;
ALTER TABLE "SaleDispatch" ADD COLUMN IF NOT EXISTS "driverName"    TEXT;
ALTER TABLE "SaleDispatch" ADD COLUMN IF NOT EXISTS "driverPhone"   TEXT;
ALTER TABLE "Payment"      ADD COLUMN IF NOT EXISTS "screenshotUrl" TEXT;
ALTER TABLE "CompanyProfile" ADD COLUMN IF NOT EXISTS "ownerWhatsappNumber" TEXT;

-- 2. New enum types ----------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "WaDirection" AS ENUM ('OUTBOUND', 'INBOUND');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "WaStatus" AS ENUM ('SENT', 'FAILED', 'SKIPPED', 'RECEIVED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "TransportConfirmationStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'DISMISSED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- 3. WhatsAppLog -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "WhatsAppLog" (
    "id"           TEXT NOT NULL,
    "direction"    "WaDirection" NOT NULL DEFAULT 'OUTBOUND',
    "phone"        TEXT,
    "template"     TEXT,
    "body"         TEXT,
    "mediaUrl"     TEXT,
    "relatedType"  TEXT,
    "relatedId"    TEXT,
    "status"       "WaStatus" NOT NULL,
    "errorMessage" TEXT,
    "providerId"   TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WhatsAppLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "WhatsAppLog_relatedType_relatedId_idx"
    ON "WhatsAppLog"("relatedType", "relatedId");
CREATE INDEX IF NOT EXISTS "WhatsAppLog_createdAt_idx"
    ON "WhatsAppLog"("createdAt");

-- 4. TransportConfirmation ---------------------------------------------------
CREATE TABLE IF NOT EXISTS "TransportConfirmation" (
    "id"             TEXT NOT NULL,
    "fromPhone"      TEXT NOT NULL,
    "rawText"        TEXT NOT NULL,
    "messageDate"    TIMESTAMP(3),
    "fromPlace"      TEXT,
    "toPlace"        TEXT,
    "tonnageKg"      INTEGER,
    "lorryNumber"    TEXT,
    "driverName"     TEXT,
    "driverPhone"    TEXT,
    "freightAmount"  DECIMAL(12,2),
    "status"         "TransportConfirmationStatus" NOT NULL DEFAULT 'DRAFT',
    "saleDispatchId" TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TransportConfirmation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "TransportConfirmation_status_idx"
    ON "TransportConfirmation"("status");
