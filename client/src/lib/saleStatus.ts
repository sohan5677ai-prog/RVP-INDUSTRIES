import type { SaleOrder, SaleDispatch, Receipt } from './types';

/** Lifecycle a sale moves through, with PAID layered on top of the DB status
 *  (payment is tracked via receipts, not a column on the order). */
export type SaleDisplayStatus = 'PENDING' | 'PARTIAL' | 'DISPATCHED' | 'DELIVERED' | 'PAID';

/** Shared badge colour per status, used on every sales page so the lifecycle
 *  reads the same everywhere: amber → grey → blue → green → solid. */
export const SALE_STATUS_VARIANT: Record<SaleDisplayStatus, 'soft' | 'warning' | 'success' | 'outline' | 'default'> = {
  PENDING: 'warning',
  PARTIAL: 'outline',
  DISPATCHED: 'soft',
  DELIVERED: 'success',
  PAID: 'default',
};

export function saleStatusLabel(s: SaleDisplayStatus): string {
  return s.charAt(0) + s.slice(1).toLowerCase();
}

/** Full invoice value for a shipment. Must match the Sale Dues page exactly, since
 *  that page is where buyer receipts are recorded and allocated: it treats the
 *  invoice as `base + (gstAmount || 0)` — i.e. no GST is assumed when the dispatch
 *  has no gstAmount. Adding a 5% GST fallback here (as before) made a dispatch that
 *  Sale Dues already settled at base look 5% short, so it wrongly kept showing an
 *  unpaid "Mark Paid" action on the product sales pages. */
function dispatchTotal(d: SaleDispatch, ratePerKg: number): number {
  const base = d.weightKg * ratePerKg;
  const gst = Number(d.gstAmount) || 0;
  return Math.round(base + gst);
}

/** Just the receipt fields needed to tally what a shipment has cleared. Lets
 *  callers pass either full Receipt rows or the trimmed shape the sales list
 *  embeds on each dispatch. */
type SettleReceipt = Pick<Receipt, 'type' | 'saleDispatchId' | 'amount' | 'tdsAmount' | 'shortageAmount'>;

/** Amount cleared against each shipment from its directly-linked buyer receipts
 *  (cash + TDS + shortage all count as clearing, same as Sale Dues FIFO). */
export function settledByDispatch(receipts: SettleReceipt[] | undefined): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of receipts ?? []) {
    if (r.type !== 'BUYER' || !r.saleDispatchId) continue;
    const amt = Number(r.amount) + Number(r.tdsAmount ?? 0) + Number(r.shortageAmount ?? 0);
    m.set(r.saleDispatchId, (m.get(r.saleDispatchId) ?? 0) + amt);
  }
  return m;
}

/** A shipment is Paid once its receipts cover its full invoice value. */
export function isDispatchPaid(d: SaleDispatch, ratePerKg: number, settled: Map<string, number>): boolean {
  const got = settled.get(d.id) ?? 0;
  return got > 0 && got >= dispatchTotal(d, ratePerKg) - 0.01;
}

/** Order status for display: PAID once it is fully shipped and every shipment is
 *  paid; otherwise the underlying lifecycle status (PENDING/PARTIAL/DISPATCHED/DELIVERED). */
export function saleDisplayStatus(o: SaleOrder, settled: Map<string, number>): SaleDisplayStatus {
  const dispatches = o.dispatches ?? [];
  const fullyShipped = o.status === 'DISPATCHED' || o.status === 'DELIVERED';
  if (fullyShipped && dispatches.length > 0 && dispatches.every((d) => isDispatchPaid(d, Number(o.ratePerKg), settled))) {
    return 'PAID';
  }
  return o.status;
}
