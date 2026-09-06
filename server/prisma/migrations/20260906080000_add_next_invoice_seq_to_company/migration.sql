-- AlterTable
ALTER TABLE "CompanyProfile" ADD COLUMN IF NOT EXISTS "nextInvoiceSeq" INTEGER;
ALTER TABLE "CompanyProfile" ADD COLUMN IF NOT EXISTS "nextUrsInvoiceSeq" INTEGER;

