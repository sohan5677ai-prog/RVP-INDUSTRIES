import type { MasterEntity } from '@prisma/client';
import type { Permission } from './permissions.js';

/**
 * Which master fields need a second person, and how every field is labelled
 * in the change history (plan items 3.1, 3.4, 3.5).
 *
 * The protected set is the answer to "what would someone change to divert a
 * payment, and what would they change first to stop anyone noticing".
 */

export interface ProtectedField {
  /** Column on the model. */
  field: string;
  /** What to call it in an alert or an approval screen. */
  label: string;
  /** Permission required to approve a change to it. */
  approvePermission: Permission;
}

/**
 * Party fields that cannot be changed in one step.
 *
 * `email` is here for a reason that is not obvious: it is where the alert
 * about a bank change is sent. Leaving it editable in one step means an
 * attacker changes the email first and the account second, and the warning
 * arrives in their own inbox. Protecting the account without protecting the
 * address that reports on it protects nothing.
 *
 * `gstin` is here because it drives invoicing and the GST return, so a quiet
 * change misstates tax rather than diverting cash - different harm, same need
 * for a second pair of eyes.
 *
 * Deliberately NOT here: name, address, phone, commodities. Those change often
 * and legitimately, and routing them through approval would teach everyone to
 * approve without reading - which is how the control stops working.
 */
export const PARTY_PROTECTED: readonly ProtectedField[] = [
  { field: 'bankAccountNumber', label: 'Bank account number', approvePermission: 'master.party.bank.edit' },
  { field: 'bankIfsc', label: 'IFSC code', approvePermission: 'master.party.bank.edit' },
  { field: 'bankName', label: 'Bank name', approvePermission: 'master.party.bank.edit' },
  { field: 'gstin', label: 'GSTIN', approvePermission: 'master.party.manage' },
  { field: 'email', label: 'Email address', approvePermission: 'master.party.bank.edit' },
];

/** The company's own bank details, printed on every invoice. */
export const COMPANY_PROTECTED: readonly ProtectedField[] = [
  { field: 'bankAccountName', label: 'Account holder name', approvePermission: 'settings.manage' },
  { field: 'bankAccountNumber', label: 'Bank account number', approvePermission: 'settings.manage' },
  { field: 'bankBranchIfsc', label: 'IFSC code', approvePermission: 'settings.manage' },
  { field: 'gstin', label: 'GSTIN', approvePermission: 'settings.manage' },
];

export function protectedFieldsFor(entity: MasterEntity): readonly ProtectedField[] {
  switch (entity) {
    case 'PARTY':
      return PARTY_PROTECTED;
    case 'COMPANY':
      return COMPANY_PROTECTED;
    // Brokers and transports hold no bank details today. They still get full
    // change history; they just have nothing that needs approval.
    default:
      return [];
  }
}

export function isProtectedField(entity: MasterEntity, field: string): boolean {
  return protectedFieldsFor(entity).some((f) => f.field === field);
}

/* --------------------------------------------------------------- diffing - */

export interface FieldChange {
  field: string;
  label: string;
  oldValue: string | null;
  newValue: string | null;
  protected: boolean;
}

/** Render any column value as the text the history and the alerts show. */
function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  const s = String(value);
  return s.length === 0 ? null : s;
}

/**
 * Compare what was sent against what is stored, and return only what actually
 * changed.
 *
 * Treats null, undefined and empty string as the same thing, because a form
 * that posts `""` for an untouched optional field would otherwise look like a
 * change from null - and a history full of phantom edits is one nobody reads.
 *
 * Only keys present in `incoming` are considered, so a partial update does not
 * read as clearing everything it omitted.
 */
export function diffFields(
  entity: MasterEntity,
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  labels: Record<string, string> = {}
): FieldChange[] {
  const protectedList = protectedFieldsFor(entity);
  const changes: FieldChange[] = [];

  for (const [field, raw] of Object.entries(incoming)) {
    if (raw === undefined) continue;
    const before = asText(existing[field]);
    const after = asText(raw);
    if (before === after) continue;

    const prot = protectedList.find((p) => p.field === field);
    changes.push({
      field,
      label: prot?.label ?? labels[field] ?? humanise(field),
      oldValue: before,
      newValue: after,
      protected: !!prot,
    });
  }

  return changes;
}

/** `bankAccountNumber` -> `Bank account number`. */
export function humanise(field: string): string {
  const spaced = field.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[._-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/**
 * Split a set of changes into the ones that can be applied now and the ones
 * that need approval.
 */
export function splitByProtection(changes: FieldChange[]): {
  immediate: FieldChange[];
  needsApproval: FieldChange[];
} {
  return {
    immediate: changes.filter((c) => !c.protected),
    needsApproval: changes.filter((c) => c.protected),
  };
}

/**
 * The permission needed to approve a batch.
 *
 * Where a batch touches fields with different approval permissions, the
 * stricter one wins - `master.party.bank.edit` over `master.party.manage` -
 * so bundling a GSTIN change with a bank change cannot lower the bar for the
 * bank change.
 */
export function approvalPermissionFor(
  entity: MasterEntity,
  changes: FieldChange[]
): Permission {
  const list = protectedFieldsFor(entity);
  const needed = changes
    .map((c) => list.find((p) => p.field === c.field)?.approvePermission)
    .filter((p): p is Permission => !!p);

  if (needed.includes('master.party.bank.edit')) return 'master.party.bank.edit';
  if (needed.includes('settings.manage')) return 'settings.manage';
  return needed[0] ?? 'master.party.manage';
}

/** A one-line summary for the approval screen and the alert subject. */
export function summarise(entityName: string, changes: FieldChange[]): string {
  const fields = changes.map((c) => c.label.toLowerCase()).join(', ');
  return `${entityName}: ${fields}`;
}

/**
 * Mask an account number for an alert: an email about a bank change should
 * not itself carry the full new account number to an inbox.
 */
export function maskAccount(value: string | null): string {
  if (!value) return '(empty)';
  const trimmed = value.trim();
  if (trimmed.length <= 4) return '••••';
  return `••••${trimmed.slice(-4)}`;
}
