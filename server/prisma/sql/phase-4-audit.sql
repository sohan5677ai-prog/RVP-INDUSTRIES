-- AlterTable
ALTER TABLE "JournalEntry" ADD COLUMN     "reversalOfId" TEXT;

-- AlterTable
ALTER TABLE "CompanyProfile" ADD COLUMN     "auditRetentionDays" INTEGER,
ADD COLUMN     "inboundApproachAlertsEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "inboundApproachRingKm" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "inboundGateRingKm" INTEGER NOT NULL DEFAULT 3;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" TEXT,
ADD COLUMN     "cancelledByName" TEXT;

-- AlterTable
ALTER TABLE "Receipt" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" TEXT,
ADD COLUMN     "cancelledByName" TEXT;

-- AlterTable
ALTER TABLE "PartySetOff" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" TEXT,
ADD COLUMN     "cancelledByName" TEXT;

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "seq" BIGINT NOT NULL,
    "hash" TEXT NOT NULL,
    "prevHash" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT,
    "entityId" TEXT,
    "entityLabel" TEXT,
    "oldValues" JSONB,
    "newValues" JSONB,
    "userId" TEXT,
    "userName" TEXT,
    "userRole" "Role",
    "ip" TEXT,
    "userAgent" TEXT,
    "requestId" TEXT,
    "method" TEXT,
    "path" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PeriodLock" (
    "id" TEXT NOT NULL,
    "fromDate" TIMESTAMP(3) NOT NULL,
    "toDate" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "lockedById" TEXT NOT NULL,
    "lockedByName" TEXT,
    "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unlockedById" TEXT,
    "unlockedByName" TEXT,
    "unlockedAt" TIMESTAMP(3),
    "unlockReason" TEXT,

    CONSTRAINT "PeriodLock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApproachAlert" (
    "id" TEXT NOT NULL,
    "transportConfirmationId" TEXT NOT NULL,
    "ringKm" INTEGER NOT NULL,
    "distanceKm" DOUBLE PRECISION NOT NULL,
    "notifiedCount" INTEGER NOT NULL DEFAULT 0,
    "firedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApproachAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_seq_key" ON "AuditLog"("seq");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_createdAt_idx" ON "AuditLog"("entity", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_requestId_idx" ON "AuditLog"("requestId");

-- CreateIndex
CREATE INDEX "PeriodLock_fromDate_toDate_idx" ON "PeriodLock"("fromDate", "toDate");

-- CreateIndex
CREATE INDEX "PeriodLock_unlockedAt_idx" ON "PeriodLock"("unlockedAt");

-- CreateIndex
CREATE INDEX "ApproachAlert_firedAt_idx" ON "ApproachAlert"("firedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApproachAlert_transportConfirmationId_ringKm_key" ON "ApproachAlert"("transportConfirmationId", "ringKm");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_reversalOfId_key" ON "JournalEntry"("reversalOfId");

-- CreateIndex
CREATE INDEX "JournalEntry_reversalOfId_idx" ON "JournalEntry"("reversalOfId");

-- CreateIndex
CREATE INDEX "PartySetOff_cancelledAt_idx" ON "PartySetOff"("cancelledAt");

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportConfirmation" ADD CONSTRAINT "TransportConfirmation_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

