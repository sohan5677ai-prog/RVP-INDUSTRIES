-- Company profile (seller details + bank) and per-product tax info for invoices.
CREATE TABLE "CompanyProfile" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "name" TEXT NOT NULL DEFAULT 'RVP INDUSTRIES',
  "address" TEXT,
  "gstin" TEXT,
  "stateName" TEXT,
  "stateCode" TEXT,
  "contact" TEXT,
  "bankAccountName" TEXT,
  "bankName" TEXT,
  "bankAccountNumber" TEXT,
  "bankBranchIfsc" TEXT,
  "invoicePrefix" TEXT NOT NULL DEFAULT 'RVP',
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CompanyProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProductTaxInfo" (
  "id" TEXT NOT NULL,
  "product" "SaleProduct" NOT NULL,
  "hsn" TEXT,
  "description" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProductTaxInfo_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductTaxInfo_product_key" ON "ProductTaxInfo"("product");

-- Generated tax invoice numbering on the sale order.
ALTER TABLE "SaleOrder"
  ADD COLUMN "invoiceSeq" INTEGER,
  ADD COLUMN "invoiceFy" TEXT,
  ADD COLUMN "invoiceDate" TIMESTAMP(3);

CREATE UNIQUE INDEX "SaleOrder_invoiceFy_invoiceSeq_key" ON "SaleOrder"("invoiceFy", "invoiceSeq");
