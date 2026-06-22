-- Sale order payment terms: credit "due days" counted from the received date.
ALTER TABLE "SaleOrder" ADD COLUMN "dueDays" INTEGER;
ALTER TABLE "SaleOrder" ADD COLUMN "receivedDate" TIMESTAMP(3);
