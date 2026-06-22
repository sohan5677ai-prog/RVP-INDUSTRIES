-- Persisted invoice print layout (paper size, margins, font, column widths) as JSON.
ALTER TABLE "CompanyProfile" ADD COLUMN "invoiceLayout" TEXT;
