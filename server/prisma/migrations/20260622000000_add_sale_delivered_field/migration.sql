-- AlterEnum
ALTER TYPE "SaleStatus" ADD VALUE 'DELIVERED';

-- AlterTable
ALTER TABLE "SaleOrder" ADD COLUMN "deliveredDate" TIMESTAMP(3);
