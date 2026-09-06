-- Cloud DB sync for Driver Kata Webhook & Submissions
-- Safe to run: every statement is additive and idempotent (IF NOT EXISTS / duplicate-object guards)

-- 1. Enum
DO $$ BEGIN
  CREATE TYPE "KataSubmissionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- 2. New columns on existing tables
ALTER TABLE "WhatsAppLog" ADD COLUMN IF NOT EXISTS "mediaType" TEXT;

-- 3. DriverKataSubmission table
CREATE TABLE IF NOT EXISTS "DriverKataSubmission" (
    "id"              TEXT NOT NULL,
    "saleDispatchId"  TEXT NOT NULL,
    "driverPhone"     TEXT NOT NULL,
    "imageUrl"        TEXT NOT NULL,
    "rawOcrResult"    JSONB,
    "ocrBuyerKataKg"  INTEGER,
    "ocrLorryNumber"  TEXT,
    "ocrBuyerName"    TEXT,
    "status"          "KataSubmissionStatus" NOT NULL DEFAULT 'PENDING',
    "confirmedKg"     INTEGER,
    "confirmedBy"     TEXT,
    "confirmedAt"     TIMESTAMP(3),
    "rejectionReason" TEXT,
    "slackChannel"    TEXT,
    "slackTs"         TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DriverKataSubmission_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DriverKataSubmission_saleDispatchId_fkey" FOREIGN KEY ("saleDispatchId") REFERENCES "SaleDispatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "DriverKataSubmission_saleDispatchId_idx" ON "DriverKataSubmission"("saleDispatchId");
CREATE INDEX IF NOT EXISTS "DriverKataSubmission_driverPhone_idx" ON "DriverKataSubmission"("driverPhone");
CREATE INDEX IF NOT EXISTS "DriverKataSubmission_status_idx" ON "DriverKataSubmission"("status");
