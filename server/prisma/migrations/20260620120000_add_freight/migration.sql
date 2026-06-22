-- Inward freight on BASE-priced purchases; outward delivery freight on sales.

ALTER TABLE "Purchase"
  ADD COLUMN "freightCharge" DECIMAL(12,2) NOT NULL DEFAULT 0;

ALTER TABLE "SaleOrder"
  ADD COLUMN "destination" TEXT,
  ADD COLUMN "freightCharge" DECIMAL(12,2) NOT NULL DEFAULT 0;
