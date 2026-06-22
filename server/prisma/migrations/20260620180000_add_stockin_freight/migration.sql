-- Inward freight captured at Stock In (BASE-priced POs), carried into the purchase.
ALTER TABLE "StockIn" ADD COLUMN "freightCharge" DECIMAL(12,2) NOT NULL DEFAULT 0;
