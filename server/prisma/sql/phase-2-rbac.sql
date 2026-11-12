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

