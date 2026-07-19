import type { QueryClient } from '@tanstack/react-query';

/**
 * Every query whose data can change when a receipt is created or deleted.
 *
 * Receipts are the single source of truth for buyer settlement, but three pages
 * read that truth through different query keys:
 *   - Receipts register  → ['receipts']
 *   - Sale Dues          → ['receipts'] (FIFO allocation)
 *   - Product sales pages → ['sale-orders'] (receipts embedded per dispatch)
 * plus the ledger/dashboard views that a receipt's journal entry feeds.
 *
 * Any create/delete of a receipt MUST invalidate all of them together, or one
 * page will keep showing a row (or a "Paid" badge) that another page just
 * removed. Call this from every receipt mutation so the three pages can never
 * disagree about what has been received.
 */
export function invalidateReceiptQueries(qc: QueryClient) {
  for (const key of [
    ['receipts'],
    ['sale-orders'],
    ['accounts'],
    ['journal-entries'],
    ['dashboard'],
    ['pappu-margins'],
  ]) {
    qc.invalidateQueries({ queryKey: key });
  }
}
