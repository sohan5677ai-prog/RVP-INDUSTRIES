-- CreateEnum
CREATE TYPE "MasterEntity" AS ENUM ('PARTY', 'BROKER', 'TRANSPORT', 'COMPANY');

-- AlterTable
ALTER TABLE "CompanyProfile" ADD COLUMN     "securityAlertEmails" TEXT;

-- CreateTable
CREATE TABLE "MasterChangeLog" (
    "id" TEXT NOT NULL,
    "entity" "MasterEntity" NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityName" TEXT,
    "field" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "protected" BOOLEAN NOT NULL DEFAULT false,
    "changedById" TEXT,
    "changedByName" TEXT,
    "approvedById" TEXT,
    "approvedByName" TEXT,
    "pendingChangeId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MasterChangeLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MasterChangeLog_entity_entityId_createdAt_idx" ON "MasterChangeLog"("entity", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "MasterChangeLog_createdAt_idx" ON "MasterChangeLog"("createdAt");

-- CreateIndex
CREATE INDEX "MasterChangeLog_protected_createdAt_idx" ON "MasterChangeLog"("protected", "createdAt");

