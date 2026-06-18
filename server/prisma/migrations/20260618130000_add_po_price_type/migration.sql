-- Price basis for a purchase order: BASE (at supplier) or DELIVERY (at our location)
CREATE TYPE "PriceType" AS ENUM ('BASE', 'DELIVERY');
ALTER TABLE "PurchaseOrder" ADD COLUMN "priceType" "PriceType" NOT NULL DEFAULT 'DELIVERY';
