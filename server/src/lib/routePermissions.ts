import type { Permission } from './permissions.js';

/**
 * Which permission each route requires (plan item 2.1).
 *
 * One table rather than `requirePermission(...)` sprinkled across 35 route
 * files, for three reasons: a reviewer or auditor can read the whole
 * authorization model on one screen; a route added without a rule is caught by
 * a test instead of silently inheriting whatever its neighbours have; and
 * applying it needed no edit to any route file, so this phase could not break
 * a route by fumbling its middleware order.
 *
 * Rules are ordered and **first match wins**, so specific paths come before the
 * general ones they sit under. `:param` matches one segment, `*` matches the
 * rest of the path.
 *
 * `null` means "any authenticated user": used only where the route is about
 * the caller's own account or is needed to render the shell of the app.
 * Everything else names a permission, and anything matching no rule at all is
 * denied when enforcing — deny by default, per plan item 6.7.
 */

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteRule {
  methods: readonly Method[] | 'ALL';
  /** Path after `/api`, e.g. `/payments/:id`. */
  path: string;
  permission: Permission | null;
  /** Why, where the mapping is not self-evident. */
  note?: string;
}

const READ: readonly Method[] = ['GET'];
const WRITE: readonly Method[] = ['POST', 'PUT', 'PATCH'];
const REMOVE: readonly Method[] = ['DELETE'];

export const ROUTE_RULES: readonly RouteRule[] = [
  // ---------------------------------------------------------------- self --
  // The caller acting on their own account. Gating these on a permission
  // would let a misconfigured role lock someone out of changing their own
  // password or signing out, which is the opposite of what this is for.
  { methods: 'ALL', path: '/auth/*', permission: null, note: 'own account' },
  { methods: 'ALL', path: '/user-notes/*', permission: 'notes.manage', note: 'ownership checked in the controller' },
  { methods: 'ALL', path: '/user-notes', permission: 'notes.manage' },

  // ------------------------------------------------------------- masters --
  { methods: READ, path: '/parties/*', permission: 'master.party.view' },
  { methods: READ, path: '/parties', permission: 'master.party.view' },
  { methods: REMOVE, path: '/parties/*', permission: 'master.party.delete' },
  { methods: WRITE, path: '/parties/*', permission: 'master.party.manage' },
  { methods: WRITE, path: '/parties', permission: 'master.party.manage' },

  { methods: READ, path: '/brokers*', permission: 'master.broker.view' },
  { methods: REMOVE, path: '/brokers/*', permission: 'master.broker.delete' },
  { methods: WRITE, path: '/brokers*', permission: 'master.broker.manage' },

  { methods: READ, path: '/transports*', permission: 'master.transport.view' },
  { methods: REMOVE, path: '/transports/*', permission: 'master.transport.delete' },
  { methods: WRITE, path: '/transports*', permission: 'master.transport.manage' },

  // ----------------------------------------------------------- purchases --
  { methods: READ, path: '/verifications*', permission: 'purchase.view' },
  { methods: 'ALL', path: '/verifications*', permission: 'purchase.verification.manage' },
  { methods: READ, path: '/hamali-verifications*', permission: 'purchase.view' },
  { methods: 'ALL', path: '/hamali-verifications*', permission: 'purchase.hamali.manage' },
  { methods: READ, path: '/manual-hamali-costs*', permission: 'purchase.view' },
  { methods: 'ALL', path: '/manual-hamali-costs*', permission: 'purchase.hamali.manage' },

  { methods: READ, path: '/purchase-orders*', permission: 'purchase.view' },
  { methods: READ, path: '/purchases*', permission: 'purchase.view' },
  { methods: READ, path: '/stock-in*', permission: 'purchase.view' },
  { methods: REMOVE, path: '/purchase-orders/*', permission: 'purchase.delete' },
  { methods: REMOVE, path: '/purchases/*', permission: 'purchase.delete' },
  { methods: REMOVE, path: '/stock-in/*', permission: 'purchase.delete' },
  { methods: WRITE, path: '/purchase-orders*', permission: 'purchase.manage' },
  { methods: WRITE, path: '/purchases*', permission: 'purchase.manage' },
  { methods: WRITE, path: '/stock-in*', permission: 'purchase.manage' },
  { methods: 'ALL', path: '/bulk-import/*', permission: 'purchase.manage', note: 'spreadsheet import feeds purchases and masters' },

  // --------------------------------------------------------------- sales --
  { methods: 'ALL', path: '/sale-dispatches/:id/invoice*', permission: 'sale.invoice.issue' },
  { methods: 'ALL', path: '/sale-dispatches/:id/einvoice*', permission: 'sale.invoice.issue' },
  { methods: 'ALL', path: '/sale-dispatches/:id/ewb*', permission: 'sale.invoice.issue' },
  { methods: READ, path: '/sale-dispatches*', permission: 'sale.view' },
  { methods: REMOVE, path: '/sale-dispatches/*', permission: 'sale.delete' },
  { methods: WRITE, path: '/sale-dispatches*', permission: 'sale.dispatch.manage' },

  { methods: READ, path: '/sale-orders*', permission: 'sale.view' },
  { methods: READ, path: '/sale-dues*', permission: 'sale.view' },
  { methods: REMOVE, path: '/sale-orders/*', permission: 'sale.delete' },
  { methods: WRITE, path: '/sale-orders*', permission: 'sale.manage' },
  { methods: WRITE, path: '/sale-dues*', permission: 'sale.manage' },

  { methods: 'ALL', path: '/credit-notes/:id/einvoice*', permission: 'sale.invoice.issue' },
  { methods: 'ALL', path: '/debit-notes/:id/einvoice*', permission: 'sale.invoice.issue' },
  { methods: READ, path: '/credit-notes*', permission: 'sale.view' },
  { methods: READ, path: '/debit-notes*', permission: 'sale.view' },
  { methods: REMOVE, path: '/credit-notes/*', permission: 'sale.delete' },
  { methods: REMOVE, path: '/debit-notes/*', permission: 'sale.delete' },
  { methods: WRITE, path: '/credit-notes*', permission: 'sale.manage' },
  { methods: WRITE, path: '/debit-notes*', permission: 'sale.manage' },

  { methods: 'ALL', path: '/delivery-challans/:id/ewb*', permission: 'sale.invoice.issue' },
  { methods: READ, path: '/delivery-challans*', permission: 'sale.view' },
  { methods: 'ALL', path: '/delivery-challans*', permission: 'sale.dispatch.manage' },

  // Live lorry positions pushed by the GPS provider. Read-only, and gated on
  // sale.view because the only reason to look is "where is this dispatch" -
  // the people who read the dispatch board are the people who need it. The
  // provider's own push endpoint is public and sits outside this model; it
  // authenticates with GPS_PUSH_TOKEN instead.
  { methods: READ, path: '/gps/*', permission: 'sale.view' },

  // --------------------------------------------------------------- money --
  { methods: READ, path: '/payments*', permission: 'payment.view' },
  { methods: REMOVE, path: '/payments/*', permission: 'payment.delete' },
  { methods: WRITE, path: '/payments*', permission: 'payment.manage' },

  { methods: READ, path: '/receipts*', permission: 'receipt.view' },
  { methods: REMOVE, path: '/receipts/*', permission: 'receipt.delete' },
  { methods: WRITE, path: '/receipts*', permission: 'receipt.manage' },

  { methods: READ, path: '/set-offs*', permission: 'setoff.view' },
  { methods: REMOVE, path: '/set-offs/*', permission: 'setoff.delete' },
  { methods: WRITE, path: '/set-offs*', permission: 'setoff.manage' },

  { methods: READ, path: '/loans*', permission: 'loan.view' },
  { methods: READ, path: '/loan-repayments*', permission: 'loan.view' },
  { methods: READ, path: '/private-loans*', permission: 'loan.view' },
  { methods: READ, path: '/private-loan-repayments*', permission: 'loan.view' },
  { methods: REMOVE, path: '/loans/*', permission: 'loan.delete' },
  { methods: REMOVE, path: '/loan-repayments/*', permission: 'loan.delete' },
  { methods: REMOVE, path: '/private-loans/*', permission: 'loan.delete' },
  { methods: REMOVE, path: '/private-loan-repayments/*', permission: 'loan.delete' },
  { methods: 'ALL', path: '/loans*', permission: 'loan.manage' },
  { methods: 'ALL', path: '/private-loans*', permission: 'loan.manage' },
  { methods: 'ALL', path: '/private-loan-repayments*', permission: 'loan.manage' },

  // ----------------------------------------------------------- inventory --
  { methods: READ, path: '/inventory*', permission: 'inventory.view' },
  { methods: 'ALL', path: '/inventory*', permission: 'inventory.manage' },
  { methods: READ, path: '/stock-transfers*', permission: 'inventory.view' },
  { methods: READ, path: '/shell-transfers*', permission: 'inventory.view' },
  { methods: READ, path: '/husk-transfers*', permission: 'inventory.view' },
  { methods: READ, path: '/dust-purchases*', permission: 'inventory.view' },
  { methods: REMOVE, path: '/stock-transfers/*', permission: 'inventory.delete' },
  { methods: REMOVE, path: '/shell-transfers/*', permission: 'inventory.delete' },
  { methods: REMOVE, path: '/husk-transfers/*', permission: 'inventory.delete' },
  { methods: REMOVE, path: '/dust-purchases/*', permission: 'inventory.delete' },
  { methods: 'ALL', path: '/stock-transfers*', permission: 'inventory.manage' },
  { methods: 'ALL', path: '/shell-transfers*', permission: 'inventory.manage' },
  { methods: 'ALL', path: '/husk-transfers*', permission: 'inventory.manage' },
  { methods: 'ALL', path: '/dust-purchases*', permission: 'inventory.manage' },

  { methods: READ, path: '/weighbridge*', permission: 'weighbridge.view' },
  { methods: REMOVE, path: '/weighbridge/*', permission: 'weighbridge.delete' },
  { methods: 'ALL', path: '/weighbridge*', permission: 'weighbridge.manage' },

  // --------------------------------------------- the pool report / P&L ----
  // All of these are the entries behind the pool report and the P&L page.
  ...[
    '/drawings',
    '/electricity-bills',
    '/gunny-bags',
    '/gunny-sales',
    '/interest-charges',
    '/maintenance-expenses',
    '/misc-expenses',
    '/other-income',
    '/storage-maintenance',
    '/subscription-charges',
    // The recurring-expense plan config, NOT the licensing subscription -
    // it lives in poolReport.routes.ts and feeds the P&L. `/subscription*`
    // deliberately does not match it, since that star only spans `/...`.
    '/subscription-plans',
    '/term-loan-principals',
  ].flatMap((base): RouteRule[] => [
    { methods: READ, path: `${base}*`, permission: 'poolreport.view' },
    { methods: REMOVE, path: `${base}/*`, permission: 'poolreport.delete' },
    { methods: 'ALL', path: `${base}*`, permission: 'poolreport.manage' },
  ]),

  // -------------------------------------------------- books & reporting ---
  { methods: READ, path: '/ledger*', permission: 'ledger.view' },
  { methods: READ, path: '/reports*', permission: 'report.view' },
  { methods: READ, path: '/dashboard*', permission: 'dashboard.view' },
  { methods: READ, path: '/search', permission: 'dashboard.view', note: 'global search spans modules; narrowed in Phase 5' },
  { methods: READ, path: '/company-profile', permission: 'settings.view' },

  { methods: READ, path: '/gstr2b*', permission: 'tax.view' },
  { methods: 'ALL', path: '/gstr2b*', permission: 'tax.manage' },
  { methods: READ, path: '/taxpro*', permission: 'tax.view' },
  { methods: 'ALL', path: '/taxpro*', permission: 'tax.manage' },

  // ------------------------------------------------------ communication ---
  { methods: READ, path: '/credit-notes/pending', permission: 'sale.view' },
  { methods: READ, path: '/email-logs*', permission: 'email.view' },
  { methods: 'ALL', path: '/email-logs/*', permission: 'sale.manage', note: 'resending a document email re-sends a sale document' },

  { methods: READ, path: '/whatsapp*', permission: 'whatsapp.view' },
  { methods: ['POST'], path: '/whatsapp*', permission: 'whatsapp.send' },
  { methods: 'ALL', path: '/whatsapp*', permission: 'whatsapp.manage' },
  { methods: 'ALL', path: '/wishes*', permission: 'wishes.manage' },

  { methods: READ, path: '/support*', permission: 'support.view' },
  { methods: 'ALL', path: '/support*', permission: 'support.manage' },

  { methods: READ, path: '/notes*', permission: 'notes.view' },
  { methods: 'ALL', path: '/notes*', permission: 'notes.manage' },

  // ----------------------------------------------------- administration ---
  { methods: READ, path: '/settings*', permission: 'settings.view' },
  { methods: 'ALL', path: '/settings*', permission: 'settings.manage' },
  { methods: READ, path: '/users*', permission: 'user.view' },
  { methods: 'ALL', path: '/users*', permission: 'user.manage' },
  { methods: 'ALL', path: '/roles*', permission: 'role.manage' },
  { methods: 'ALL', path: '/permission-denials*', permission: 'role.manage', note: 'shows who attempted what' },
  // The outer gate only. Which requests you may actually decide is settled in
  // makerChecker.service.ts against the permission each request recorded, plus
  // the rule that you cannot approve your own.
  { methods: 'ALL', path: '/pending-changes*', permission: 'approval.view' },
  // Field-level history for a master record. Behind audit.view rather than the
  // record's own view permission, because the history shows previous bank
  // account numbers - more than someone merely reading the party needs.
  { methods: READ, path: '/master-history/*', permission: 'audit.view' },
  { methods: READ, path: '/system*', permission: 'system.view' },
  { methods: 'ALL', path: '/system*', permission: 'system.manage' },
  { methods: READ, path: '/archive*', permission: 'archive.view' },
  { methods: 'ALL', path: '/archive*', permission: 'archive.manage' },
  { methods: READ, path: '/subscription*', permission: 'subscription.view' },
  { methods: 'ALL', path: '/subscription*', permission: 'subscription.manage' },
];

/* ------------------------------------------------------------- matching -- */

/**
 * Compile a pattern to a regex. `:param` matches exactly one segment.
 *
 * The two star forms mean different things, and the difference matters:
 *
 *   `/brokers*`   the collection AND everything under it
 *   `/brokers/*`  only things under it, NOT `/brokers` itself
 *
 * That is what lets `DELETE /parties/*` mean `master.party.delete` without
 * also claiming a hypothetical `DELETE /parties`. Getting this wrong the first
 * time left `/payments/*` compiling to a regex that matched `/payments/` and
 * nothing else, so every delete rule silently failed to match — which the
 * coverage test caught.
 */
function compile(pattern: string): RegExp {
  let body = pattern;
  let suffix = '';

  if (body.endsWith('/*')) {
    body = body.slice(0, -2);
    suffix = '/.+'; // at least one more segment
  } else if (body.endsWith('*')) {
    body = body.slice(0, -1);
    suffix = '(?:/.*)?';
  }

  const source = body
    .split('/')
    .filter(Boolean)
    .map((seg) =>
      seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    )
    .join('/');

  return new RegExp(`^/${source}${suffix}/?$`);
}

const compiled = ROUTE_RULES.map((rule) => ({ rule, re: compile(rule.path) }));

export interface Resolution {
  matched: boolean;
  permission: Permission | null;
  rule?: RouteRule;
}

/**
 * The permission a request needs. `matched: false` means no rule covers it,
 * which is a gap in this table rather than a licence to proceed.
 */
export function resolveRoutePermission(method: string, path: string): Resolution {
  const upper = method.toUpperCase() as Method;
  for (const { rule, re } of compiled) {
    if (rule.methods !== 'ALL' && !rule.methods.includes(upper)) continue;
    if (!re.test(path)) continue;
    return { matched: true, permission: rule.permission, rule };
  }
  return { matched: false, permission: null };
}
