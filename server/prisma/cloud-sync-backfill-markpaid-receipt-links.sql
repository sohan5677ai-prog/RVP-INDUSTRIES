-- Backfill: link historical "Mark Paid" buyer receipts to their shipments.
--
-- Older Mark-Paid receipts were created with no saleDispatchId, and their
-- TDS/shortage were stored only on the dispatch. settledByDispatch() therefore
-- couldn't tell those shipments were paid, so the sales page keeps showing
-- "Mark Paid" and the Sale Orders "Paid" badge stays dark. This copies the same
-- shape the new markDispatchPaid writes onto the old receipts.
--
-- PREREQUISITE: run cloud-sync-sales-tds-shortage.sql first — this needs the
-- Receipt.saleDispatchId / tdsAmount / shortageAmount columns to exist.
--
-- A Mark-Paid receipt is: type BUYER, saleDispatchId IS NULL, description
-- 'Payment for Invoice <token>', where <token> is the dispatch invoiceNumber
-- (or the dispatch id when it had no invoice number at the time).
--
-- Idempotent: once linked, a receipt has a non-null saleDispatchId and is
-- skipped on re-run. Only receipts/dispatches that match 1:1 and whose dispatch
-- isn't already linked are touched. Run in the Supabase SQL Editor.

-- ── STEP 1: PREVIEW (read-only) — run this first and eyeball the matches ──────
WITH candidate AS (
  SELECT r.id AS receipt_id,
         trim(substring(r.description FROM length('Payment for Invoice ') + 1)) AS token,
         r."partyId", r."tdsAmount" AS r_tds, r."shortageAmount" AS r_short, r.amount AS r_amount
  FROM "Receipt" r
  WHERE r.type = 'BUYER'
    AND r."saleDispatchId" IS NULL
    AND r.description LIKE 'Payment for Invoice %'
),
matched AS (
  SELECT c.receipt_id, c.token, c.r_tds, c.r_short, c.r_amount,
         d.id AS dispatch_id, d."invoiceNumber",
         d."tdsAmount" AS d_tds, d."creditNoteAmount" AS d_short,
         (d."weightKg" * so."ratePerKg" + d."gstAmount") AS invoice_total
  FROM candidate c
  JOIN "SaleDispatch" d ON (d."invoiceNumber" = c.token OR d.id = c.token)
  JOIN "SaleOrder" so   ON so.id = d."saleOrderId"
  WHERE (c."partyId" IS NULL OR so."buyerId" = c."partyId")
    AND NOT EXISTS (SELECT 1 FROM "Receipt" r2 WHERE r2."saleDispatchId" = d.id)
),
uniq_dispatch AS (SELECT dispatch_id FROM matched GROUP BY dispatch_id HAVING count(*) = 1),
uniq_receipt  AS (SELECT receipt_id  FROM matched GROUP BY receipt_id  HAVING count(*) = 1)
SELECT m.receipt_id, m.dispatch_id, m."invoiceNumber",
       m.r_amount, m.d_tds, m.d_short, m.invoice_total,
       (m.r_amount + COALESCE(m.r_tds, m.d_tds, 0) + COALESCE(m.r_short, m.d_short, 0)) AS cleared,
       ((m.r_amount + COALESCE(m.r_tds, m.d_tds, 0) + COALESCE(m.r_short, m.d_short, 0)) >= m.invoice_total - 0.01) AS will_read_paid
FROM matched m
JOIN uniq_dispatch ud ON ud.dispatch_id = m.dispatch_id
JOIN uniq_receipt  ur ON ur.receipt_id  = m.receipt_id
ORDER BY m."invoiceNumber";

-- ── STEP 2: APPLY — run this once the preview looks right ─────────────────────
WITH candidate AS (
  SELECT r.id AS receipt_id,
         trim(substring(r.description FROM length('Payment for Invoice ') + 1)) AS token,
         r."partyId"
  FROM "Receipt" r
  WHERE r.type = 'BUYER'
    AND r."saleDispatchId" IS NULL
    AND r.description LIKE 'Payment for Invoice %'
),
matched AS (
  SELECT c.receipt_id, c.token,
         d.id AS dispatch_id,
         NULLIF(d."tdsAmount", 0)        AS d_tds,
         NULLIF(d."creditNoteAmount", 0) AS d_short
  FROM candidate c
  JOIN "SaleDispatch" d ON (d."invoiceNumber" = c.token OR d.id = c.token)
  JOIN "SaleOrder" so   ON so.id = d."saleOrderId"
  WHERE (c."partyId" IS NULL OR so."buyerId" = c."partyId")
    AND NOT EXISTS (SELECT 1 FROM "Receipt" r2 WHERE r2."saleDispatchId" = d.id)
),
uniq_dispatch AS (SELECT dispatch_id FROM matched GROUP BY dispatch_id HAVING count(*) = 1),
uniq_receipt  AS (SELECT receipt_id  FROM matched GROUP BY receipt_id  HAVING count(*) = 1),
final AS (
  SELECT m.* FROM matched m
  JOIN uniq_dispatch ud ON ud.dispatch_id = m.dispatch_id
  JOIN uniq_receipt  ur ON ur.receipt_id  = m.receipt_id
)
UPDATE "Receipt" r
SET "saleDispatchId" = f.dispatch_id,
    "tdsAmount"      = COALESCE(r."tdsAmount", f.d_tds),
    "shortageAmount" = COALESCE(r."shortageAmount", f.d_short)
FROM final f
WHERE r.id = f.receipt_id;
