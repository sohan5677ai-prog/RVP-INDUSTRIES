-- AlterTable
ALTER TABLE "Broker" ADD COLUMN IF NOT EXISTS "email" TEXT;

-- AlterTable
ALTER TABLE "CompanyProfile" ADD COLUMN IF NOT EXISTS "companyBccEmail" TEXT;
