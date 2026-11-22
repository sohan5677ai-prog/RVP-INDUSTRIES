-- Nil register for invoice numbers that were issued and then withdrawn.
-- GST spends a document number the moment it is issued (NIC error 2278 on a
-- second IRN), so a withdrawn number is parked here and the allocator counts it
-- as consumed instead of handing it out again.
-- Idempotent: safe to re-run in the Supabase SQL editor.

CREATE TABLE IF NOT EXISTS "VoidInvoiceNumber" (
  "id"            TEXT PRIMARY KEY,
  "invoiceSeries" TEXT NOT NULL DEFAULT 'RVP',
  "invoiceFy"     TEXT NOT NULL,
  "invoiceSeq"    INTEGER NOT NULL,
  "invoiceNumber" TEXT NOT NULL,
  "invoiceDate"   TIMESTAMP(3),
  "buyerName"     TEXT,
  "reason"        TEXT,
  "voidedBy"      TEXT,
  "voidedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "VoidInvoiceNumber_invoiceFy_invoiceSeq_invoiceSeries_key"
  ON "VoidInvoiceNumber" ("invoiceFy", "invoiceSeq", "invoiceSeries");

CREATE INDEX IF NOT EXISTS "VoidInvoiceNumber_invoiceFy_invoiceSeries_idx"
  ON "VoidInvoiceNumber" ("invoiceFy", "invoiceSeries");
