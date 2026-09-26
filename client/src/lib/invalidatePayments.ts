import type { QueryClient } from '@tanstack/react-query';

/** All views derived from a payment, shared by create/edit/reversal flows. */
export function invalidatePayments(client: QueryClient) {
  return Promise.all([
    'payments', 'accounts', 'journal-entries', 'party-ledger', 'party-ledgers',
    'party-reminder-context', 'balance-sheet', 'profit-loss', 'dashboard',
  ].map(key => client.invalidateQueries({ queryKey: [key] })));
}
