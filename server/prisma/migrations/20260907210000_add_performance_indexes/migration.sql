-- Performance indexes to eliminate sequential table scans across high-volume entities

-- Party
CREATE INDEX IF NOT EXISTS "Party_type_idx" ON "Party"("type");
CREATE INDEX IF NOT EXISTS "Party_name_idx" ON "Party"("name");

-- PurchaseOrder
CREATE INDEX IF NOT EXISTS "PurchaseOrder_poDate_idx" ON "PurchaseOrder"("poDate");
CREATE INDEX IF NOT EXISTS "PurchaseOrder_status_idx" ON "PurchaseOrder"("status");

-- StockIn
CREATE INDEX IF NOT EXISTS "StockIn_arrivalDate_idx" ON "StockIn"("arrivalDate");
CREATE INDEX IF NOT EXISTS "StockIn_lorryNumber_idx" ON "StockIn"("lorryNumber");
CREATE INDEX IF NOT EXISTS "StockIn_invoiceNumber_idx" ON "StockIn"("invoiceNumber");

-- Purchase
CREATE INDEX IF NOT EXISTS "Purchase_purchaseDate_idx" ON "Purchase"("purchaseDate");

-- SaleOrder
CREATE INDEX IF NOT EXISTS "SaleOrder_product_idx" ON "SaleOrder"("product");
CREATE INDEX IF NOT EXISTS "SaleOrder_saleDate_idx" ON "SaleOrder"("saleDate");
CREATE INDEX IF NOT EXISTS "SaleOrder_status_idx" ON "SaleOrder"("status");
CREATE INDEX IF NOT EXISTS "SaleOrder_product_saleDate_idx" ON "SaleOrder"("product", "saleDate");
CREATE INDEX IF NOT EXISTS "SaleOrder_status_saleDate_idx" ON "SaleOrder"("status", "saleDate");

-- SaleDispatch
CREATE INDEX IF NOT EXISTS "SaleDispatch_dispatchDate_idx" ON "SaleDispatch"("dispatchDate");
CREATE INDEX IF NOT EXISTS "SaleDispatch_status_idx" ON "SaleDispatch"("status");
CREATE INDEX IF NOT EXISTS "SaleDispatch_vehicleNumber_idx" ON "SaleDispatch"("vehicleNumber");
CREATE INDEX IF NOT EXISTS "SaleDispatch_invoiceNumber_idx" ON "SaleDispatch"("invoiceNumber");
CREATE INDEX IF NOT EXISTS "SaleDispatch_transportId_idx" ON "SaleDispatch"("transportId");

-- JournalEntry
CREATE INDEX IF NOT EXISTS "JournalEntry_date_idx" ON "JournalEntry"("date");

-- Payment
CREATE INDEX IF NOT EXISTS "Payment_date_idx" ON "Payment"("date");
CREATE INDEX IF NOT EXISTS "Payment_type_idx" ON "Payment"("type");
CREATE INDEX IF NOT EXISTS "Payment_type_date_idx" ON "Payment"("type", "date");
CREATE INDEX IF NOT EXISTS "Payment_partyId_type_idx" ON "Payment"("partyId", "type");

-- Receipt
CREATE INDEX IF NOT EXISTS "Receipt_date_idx" ON "Receipt"("date");
CREATE INDEX IF NOT EXISTS "Receipt_type_idx" ON "Receipt"("type");
CREATE INDEX IF NOT EXISTS "Receipt_type_date_idx" ON "Receipt"("type", "date");
CREATE INDEX IF NOT EXISTS "Receipt_partyId_type_idx" ON "Receipt"("partyId", "type");
