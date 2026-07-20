/**
 * Shared math for the three buyer-receipt dialogs so they can never drift apart:
 *   • Sales product pages  → "Mark as Paid"
 *   • Sale Dues            → "Record Receipt"
 *   • Receipts register    → "Record Receipt"
 *
 * Rules (agreed with the business):
 *   – A buyer's shortage/kata claim is deducted GST-inclusive: the goods value
 *     (base = shortageKg × rate) PLUS 5% GST on that base, because the invoice the
 *     buyer is settling is itself GST-inclusive. Both parts come off the amount due.
 *   – TDS (0.1%) is charged on the sale value EXCLUDING GST (the invoice base).
 */

export const SALE_GST_RATE = 0.05; // 5% IGST fallback (matches the sale invoice math)
export const SALE_TDS_RATE = 0.001; // 0.1% TDS on sale value excluding GST

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** 5% GST on a base shortage value (0 when the sale is GST-exempt). */
export function shortageGst(base: number, gstExempt = false): number {
  if (gstExempt || !(base > 0)) return 0;
  return round2(base * SALE_GST_RATE);
}

/** Total shortage deduction (base + GST) that clears a GST-inclusive invoice. */
export function shortageWithGst(base: number, gstExempt = false): number {
  return round2((base > 0 ? base : 0) + shortageGst(base, gstExempt));
}

/** TDS (0.1%) on the sale value EXCLUDING GST. */
export function saleTds(saleBase: number): number {
  return round2((saleBase > 0 ? saleBase : 0) * SALE_TDS_RATE);
}
