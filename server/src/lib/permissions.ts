import type { Role } from '@prisma/client';

/**
 * The permission catalogue (plan item 2.1).
 *
 * Permissions are defined in code, not the database, because each one is tied
 * to specific endpoints: inventing one at runtime would grant nothing, and
 * deleting one would silently open a route. What *is* editable at runtime is
 * which permissions a role holds — see RolePermission in the schema.
 *
 * Naming is `<area>.<thing>.<action>`, and the actions are deliberately few:
 *
 *   view     read it
 *   manage   create and edit it
 *   delete   remove it, split out because deletion is the irreversible one
 *            and the audit found 44 hard-delete routes on financial documents
 *   approve  release something another person prepared (segregation of duties)
 *   export   take data out of the building (plan item 5.4)
 *
 * The split between `manage` and `delete` is the main reason this catalogue is
 * not simply read/write: before Phase 2 any signed-in user could delete a
 * payment, and nothing recorded that they had.
 */

export const PERMISSIONS = [
  // ---- masters -----------------------------------------------------------
  'master.party.view',
  'master.party.manage',
  'master.party.delete',
  /** Separated from master.party.manage: this is the vendor-fraud field. */
  'master.party.bank.view',
  'master.party.bank.edit',
  'master.broker.view',
  'master.broker.manage',
  'master.broker.delete',
  'master.transport.view',
  'master.transport.manage',
  'master.transport.delete',

  // ---- purchases ---------------------------------------------------------
  'purchase.view',
  'purchase.manage',
  'purchase.delete',
  'purchase.verification.manage',
  'purchase.hamali.manage',

  // ---- sales -------------------------------------------------------------
  'sale.view',
  'sale.manage',
  'sale.delete',
  'sale.invoice.issue',
  'sale.dispatch.manage',

  // ---- money -------------------------------------------------------------
  'payment.view',
  'payment.manage',
  'payment.delete',
  /** Releases a payment someone else entered. */
  'payment.approve',
  'receipt.view',
  'receipt.manage',
  'receipt.delete',
  'setoff.view',
  'setoff.manage',
  'setoff.delete',
  'loan.view',
  'loan.manage',
  'loan.delete',

  // ---- inventory & production -------------------------------------------
  'inventory.view',
  'inventory.manage',
  'inventory.delete',
  'weighbridge.view',
  'weighbridge.manage',
  'weighbridge.delete',

  // ---- books & reporting -------------------------------------------------
  'ledger.view',
  'report.view',
  'report.export',
  'dashboard.view',
  'poolreport.view',
  'poolreport.manage',
  'poolreport.delete',
  'tax.view',
  'tax.manage',

  // ---- communication -----------------------------------------------------
  'notes.view',
  'notes.manage',
  'whatsapp.view',
  'whatsapp.send',
  'whatsapp.manage',
  'email.view',
  'wishes.manage',
  'support.view',
  'support.manage',

  // ---- administration ----------------------------------------------------
  'settings.view',
  'settings.manage',
  'user.view',
  'user.manage',
  'role.manage',
  'system.view',
  'system.manage',
  'archive.view',
  'archive.manage',
  'subscription.view',
  'subscription.manage',
  /** Reveal a masked bank account, PAN or Aadhaar. Phase 5 audits each use. */
  'pii.view',
  /** See who did what. Phase 4 builds the log this reads. */
  'audit.view',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}

/* ------------------------------------------------------------------ roles */

/**
 * Everything except the permissions that must stay with the vendor or that
 * exist to be withheld from the person who prepared the work.
 */
const ALL: Permission[] = [...PERMISSIONS];

/**
 * Default permissions per role. These are the fallback when the database has
 * no explicit grants for a role, and the starting point the admin UI edits.
 *
 * The decisions worth defending:
 *
 * - **USER keeps the day job and loses the irreversible half.** Shop-floor and
 *   office staff still create purchases, sales, payments and weighbridge
 *   tickets, because that is the work. They lose `.delete` on financial
 *   documents, `master.party.bank.edit`, `payment.approve`, `report.export`,
 *   `pii.view` and everything administrative. Before Phase 2 they had all of
 *   it.
 * - **A creator cannot approve.** `payment.approve` is withheld from USER on
 *   purpose, so the segregation rule has something to bite on.
 * - **OWNER sees everything and signs off, but does not administer.** No
 *   `user.manage`, `role.manage` or `system.manage`: owning the business is
 *   not the same job as running the deployment, and conflating them is how an
 *   audit trail stops meaning anything.
 * - **DEVELOPER is the vendor.** It keeps everything, because it is the
 *   account that has to fix the deployment when it is broken.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  DEVELOPER: ALL,

  ADMIN: ALL.filter(
    (p) => p !== 'subscription.manage'
  ),

  OWNER: ALL.filter(
    (p) =>
      !p.startsWith('user.') &&
      !p.startsWith('role.') &&
      !p.startsWith('system.') &&
      !p.startsWith('subscription.') &&
      !p.startsWith('archive.')
  ),

  USER: [
    'master.party.view',
    'master.party.manage',
    'master.party.bank.view',
    'master.broker.view',
    'master.broker.manage',
    'master.transport.view',
    'master.transport.manage',

    'purchase.view',
    'purchase.manage',
    'purchase.verification.manage',
    'purchase.hamali.manage',

    'sale.view',
    'sale.manage',
    'sale.invoice.issue',
    'sale.dispatch.manage',

    'payment.view',
    'payment.manage',
    'receipt.view',
    'receipt.manage',
    'setoff.view',
    'loan.view',

    'inventory.view',
    'inventory.manage',
    'weighbridge.view',
    'weighbridge.manage',

    'ledger.view',
    'report.view',
    'dashboard.view',
    'poolreport.view',
    'poolreport.manage',
    'tax.view',

    'notes.view',
    'notes.manage',
    'whatsapp.view',
    'whatsapp.send',
    'email.view',
    'support.view',
    'support.manage',

    'settings.view',
  ],
};

/** Permissions a role holds by default, as a set. */
export function defaultPermissionsFor(role: Role): ReadonlySet<Permission> {
  return new Set(DEFAULT_ROLE_PERMISSIONS[role] ?? []);
}
