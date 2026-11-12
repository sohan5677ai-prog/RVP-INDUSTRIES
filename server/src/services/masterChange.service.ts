import type { MasterEntity, PendingChange } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import {
  approvalPermissionFor,
  diffFields,
  splitByProtection,
  summarise,
  type FieldChange,
} from '../lib/masterFields.js';
import { registerApplier, requestChange } from './makerChecker.service.js';
import { sendMasterChangeAlert } from './securityMail.service.js';

/**
 * Master-record changes: history for everything, approval for the sensitive
 * few (plan items 3.1, 3.4, 3.5).
 *
 * The shape of this matters more than it looks. The proposed values are held
 * in the PendingChange row and **not written to the record**, so the existing
 * bank account stays in force until someone else agrees to the new one. That
 * is the whole point: if a request alone changed the account, an attacker
 * would only need to raise one and let the next payment run before anybody
 * looked at the queue.
 */

export interface Actor {
  userId: string;
  name?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/** Write one history row per changed field. Never throws. */
export async function recordChanges(params: {
  entity: MasterEntity;
  entityId: string;
  entityName?: string | null;
  changes: FieldChange[];
  actor: Actor;
  approvedBy?: { userId: string; name?: string | null } | null;
  pendingChangeId?: string | null;
}): Promise<void> {
  if (params.changes.length === 0) return;
  try {
    await prisma.masterChangeLog.createMany({
      data: params.changes.map((c) => ({
        entity: params.entity,
        entityId: params.entityId,
        entityName: params.entityName ?? null,
        field: c.field,
        oldValue: c.oldValue,
        newValue: c.newValue,
        protected: c.protected,
        changedById: params.actor.userId,
        changedByName: params.actor.name ?? null,
        approvedById: params.approvedBy?.userId ?? null,
        approvedByName: params.approvedBy?.name ?? null,
        pendingChangeId: params.pendingChangeId ?? null,
        ip: params.actor.ip?.slice(0, 64) ?? null,
        userAgent: params.actor.userAgent?.slice(0, 255) ?? null,
      })),
    });
  } catch (err) {
    // History is evidence, not a precondition. Losing a row must not fail the
    // edit that produced it - but it must be loud, because a silent gap in an
    // audit trail is worse than a noisy one.
    logger.error('failed to write master change history', err);
  }
}

export interface SplitResult {
  /** Values safe to write straight away. */
  immediate: Record<string, unknown>;
  /** Changes held for approval, with the request raised for them. */
  pending: PendingChange | null;
  immediateChanges: FieldChange[];
  pendingChanges: FieldChange[];
}

/**
 * Work out what can be applied now and raise a request for the rest.
 *
 * Returns the subset of `incoming` that the caller should write. Anything
 * protected is stripped out, so a caller that ignores the rest of this result
 * still cannot write a bank account without approval — the safe thing happens
 * even if the calling code is wrong.
 */
export async function prepareMasterUpdate(params: {
  entity: MasterEntity;
  entityId: string;
  entityName: string;
  existing: Record<string, unknown>;
  incoming: Record<string, unknown>;
  actor: Actor;
}): Promise<SplitResult> {
  const changes = diffFields(params.entity, params.existing, params.incoming);
  const { immediate, needsApproval } = splitByProtection(changes);

  const immediateValues: Record<string, unknown> = {};
  for (const c of immediate) immediateValues[c.field] = params.incoming[c.field];

  if (needsApproval.length === 0) {
    return { immediate: immediateValues, pending: null, immediateChanges: immediate, pendingChanges: [] };
  }

  const proposed: Record<string, unknown> = {};
  const previous: Record<string, unknown> = {};
  for (const c of needsApproval) {
    proposed[c.field] = params.incoming[c.field];
    previous[c.field] = params.existing[c.field] ?? null;
  }

  const pending = await requestChange({
    subject: subjectFor(params.entity),
    subjectId: params.entityId,
    action: 'UPDATE',
    proposed,
    previous,
    summary: summarise(params.entityName, needsApproval),
    approvePermission: approvalPermissionFor(params.entity, needsApproval),
    requestedById: params.actor.userId,
    requestedByName: params.actor.name ?? null,
  });

  // Alert on the REQUEST, not only on approval. Plan item 3.2 asks for an
  // alert when it is approved; telling people when it is raised is what gives
  // them a chance to stop it, and it reaches the vendor while their old email
  // is still the one on file.
  void sendMasterChangeAlert({
    stage: 'requested',
    entity: params.entity,
    entityName: params.entityName,
    entityId: params.entityId,
    changes: needsApproval,
    actorName: params.actor.name ?? 'someone',
    vendorEmail: currentEmail(params.existing),
  });

  return {
    immediate: immediateValues,
    pending,
    immediateChanges: immediate,
    pendingChanges: needsApproval,
  };
}

function subjectFor(entity: MasterEntity): string {
  return entity === 'COMPANY' ? 'company.bank' : `${entity.toLowerCase()}.master`;
}

/**
 * The address an alert should go to: the one currently on file, not the one
 * being proposed. If the change itself is an email change, warning the new
 * address tells the attacker and not the vendor.
 */
function currentEmail(existing: Record<string, unknown>): string | null {
  const value = existing.email;
  return typeof value === 'string' && value.includes('@') ? value : null;
}

/* ------------------------------------------------------------- appliers - */

/**
 * Carry out an approved party change.
 *
 * Re-reads the record rather than trusting the `previous` snapshot: the
 * request may have sat in the queue while something else changed, and the
 * history must record what the value actually was at the moment of the write.
 */
async function applyPartyChange(change: PendingChange): Promise<void> {
  const proposed = change.proposed as Record<string, unknown>;
  const existing = await prisma.party.findUnique({ where: { id: change.subjectId ?? '' } });
  if (!existing) throw new Error(`Party ${change.subjectId} no longer exists`);

  const changes = diffFields('PARTY', existing as unknown as Record<string, unknown>, proposed);
  if (changes.length === 0) {
    // Someone already made the same change by another route. Not an error -
    // the end state is what was asked for - but worth recording as a no-op.
    logger.warn(`pending change ${change.id} applied no fields; values already current`);
    return;
  }

  await prisma.party.update({ where: { id: existing.id }, data: proposed });

  await recordChanges({
    entity: 'PARTY',
    entityId: existing.id,
    entityName: existing.name,
    changes,
    actor: { userId: change.requestedById, name: change.requestedByName },
    approvedBy: change.decidedById
      ? { userId: change.decidedById, name: change.decidedByName }
      : null,
    pendingChangeId: change.id,
  });

  void sendMasterChangeAlert({
    stage: 'approved',
    entity: 'PARTY',
    entityName: existing.name,
    entityId: existing.id,
    changes,
    actorName: change.requestedByName ?? 'someone',
    approverName: change.decidedByName ?? null,
    // The address on file BEFORE this change landed, for the same reason as
    // on request: an approved email change must not notify only the new one.
    vendorEmail: currentEmail(existing as unknown as Record<string, unknown>),
  });
}

async function applyCompanyChange(change: PendingChange): Promise<void> {
  const proposed = change.proposed as Record<string, unknown>;
  const existing = await prisma.companyProfile.findFirst();
  if (!existing) throw new Error('No company profile to update');

  const changes = diffFields('COMPANY', existing as unknown as Record<string, unknown>, proposed);
  if (changes.length === 0) return;

  await prisma.companyProfile.update({ where: { id: existing.id }, data: proposed });

  await recordChanges({
    entity: 'COMPANY',
    entityId: existing.id,
    entityName: existing.name ?? 'Company',
    changes,
    actor: { userId: change.requestedById, name: change.requestedByName },
    approvedBy: change.decidedById
      ? { userId: change.decidedById, name: change.decidedByName }
      : null,
    pendingChangeId: change.id,
  });

  void sendMasterChangeAlert({
    stage: 'approved',
    entity: 'COMPANY',
    entityName: existing.name ?? 'Company',
    entityId: existing.id,
    changes,
    actorName: change.requestedByName ?? 'someone',
    approverName: change.decidedByName ?? null,
    vendorEmail: null,
  });
}

/**
 * Wire the appliers up. Called once at boot - a subject with no applier can be
 * requested and approved but will fail loudly when applied, which is the right
 * behaviour for a half-wired workflow but not one to ship.
 */
export function registerMasterAppliers(): void {
  registerApplier('party.master', applyPartyChange);
  registerApplier('company.bank', applyCompanyChange);
}

/** History for one record, newest first. */
export async function historyFor(entity: MasterEntity, entityId: string) {
  return prisma.masterChangeLog.findMany({
    where: { entity, entityId },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
}
