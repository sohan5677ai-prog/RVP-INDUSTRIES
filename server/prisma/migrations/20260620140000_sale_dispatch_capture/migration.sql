-- Buyer default destination + sale dispatch capture (invoice/kata).
ALTER TABLE "Party" ADD COLUMN "destination" TEXT;

ALTER TABLE "SaleOrder"
  ADD COLUMN "invoiceNumber" TEXT,
  ADD COLUMN "vehicleNumber" TEXT,
  ADD COLUMN "invoiceFileUrl" TEXT,
  ADD COLUMN "kataFileUrl" TEXT;
