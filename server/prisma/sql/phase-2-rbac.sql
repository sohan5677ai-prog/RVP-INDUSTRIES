-- CreateEnum
CREATE TYPE "PendingAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE');

-- CreateEnum
CREATE TYPE "PendingStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'APPLIED', 'FAILED');

-- CreateTable
CREATE TABLE "PendingChange" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "subjectId" TEXT,
    "action" "PendingAction" NOT NULL,
    "proposed" JSONB NOT NULL,
    "previous" JSONB,
    "summary" TEXT NOT NULL,
    "approvePermission" TEXT NOT NULL,
    "amount" DECIMAL(14,2),
    "status" "PendingStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "requestedByName" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedByName" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionReason" TEXT,
    "appliedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "PendingChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalLimit" (
    "id" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "subject" TEXT NOT NULL,
    "maxAmount" DECIMAL(14,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalLimit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "id" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "permission" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PermissionDenial" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "username" TEXT,
    "role" "Role" NOT NULL,
    "permission" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "enforced" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PermissionDenial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehiclePing" (
    "id" TEXT NOT NULL,
    "vehicleNumber" TEXT NOT NULL,
    "vehicleLabel" TEXT,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "speedKmph" DOUBLE PRECISION,
    "address" TEXT,
    "ignition" BOOLEAN,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "provider" TEXT NOT NULL DEFAULT 'LOCANIX',
    "raw" JSONB,

    CONSTRAINT "VehiclePing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PendingChange_status_requestedAt_idx" ON "PendingChange"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "PendingChange_subject_subjectId_idx" ON "PendingChange"("subject", "subjectId");

-- CreateIndex
CREATE INDEX "PendingChange_requestedById_idx" ON "PendingChange"("requestedById");

-- CreateIndex
CREATE INDEX "ApprovalLimit_subject_idx" ON "ApprovalLimit"("subject");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalLimit_role_subject_key" ON "ApprovalLimit"("role", "subject");

-- CreateIndex
CREATE INDEX "RolePermission_role_idx" ON "RolePermission"("role");

-- CreateIndex
CREATE UNIQUE INDEX "RolePermission_role_permission_key" ON "RolePermission"("role", "permission");

-- CreateIndex
CREATE INDEX "PermissionDenial_createdAt_idx" ON "PermissionDenial"("createdAt");

-- CreateIndex
CREATE INDEX "PermissionDenial_permission_createdAt_idx" ON "PermissionDenial"("permission", "createdAt");

-- CreateIndex
CREATE INDEX "PermissionDenial_userId_createdAt_idx" ON "PermissionDenial"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "VehiclePing_vehicleNumber_recordedAt_idx" ON "VehiclePing"("vehicleNumber", "recordedAt");

-- CreateIndex
CREATE INDEX "VehiclePing_recordedAt_idx" ON "VehiclePing"("recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "VehiclePing_provider_vehicleNumber_recordedAt_key" ON "VehiclePing"("provider", "vehicleNumber", "recordedAt");

