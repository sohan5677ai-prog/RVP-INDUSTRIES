-- Alternate HSN for the GST-exempt (without-GST) variant of a product (e.g. husk).
ALTER TABLE "ProductTaxInfo" ADD COLUMN "hsnExempt" TEXT;
