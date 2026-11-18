import { Prisma } from '@prisma/client';

/**
 * Automatic audit capture at the database client (plan item 4.2).
 *
 * Wired here rather than in ~250 controllers because a call site that has to be
 * remembered is one a future endpoint will forget — which is exactly how the
 * anonymous scale endpoints survived the Phase 0 audit. Hooking the client
 * means a table written by code nobody has reviewed yet is still audited.
 *
 * What is deliberately NOT audited:
 *
 * - The audit log itself, which would recurse forever.
 * - The high-volume machine tables: a GPS ping every 30 seconds per lorry, a
 *   camera frame, a WhatsApp delivery receipt. Auditing those would bury the
 *   human actions the log exists to show, and they are telemetry rather than
 *   decisions.
 * - Tables that ARE the security record already (LoginAttempt,
 *   PermissionDenial, MasterChangeLog), which would double every entry.
 * - Caches and counters with no decision behind them.
 */

/** Models the extension skips entirely. */
const UNAUDITED_MODELS: ReadonlySet<string> = new Set([
  'AuditLog',
  'LoginAttempt',
  'PermissionDenial',
  'MasterChangeLog',
  'UserSession',
  'VehiclePing',
  'WhatsAppLog',
  'EmailLog',
  'PrintJob',
  'SlackDraft',
  'PoSerialCounter',
  'NoteSerialCounter',
  'ChallanSerialCounter',
]);

/** Which operations are worth a row. */
const AUDITED_OPERATIONS: ReadonlySet<string> = new Set([
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
]);

export function isAuditedModel(model: string | undefined): boolean {
  return !!model && !UNAUDITED_MODELS.has(model);
}

export function isAuditedOperation(operation: string): boolean {
  return AUDITED_OPERATIONS.has(operation);
}

/**
 * `Payment` + `update` -> `payment.update`, matching the permission naming so
 * a log line and a permission read the same way.
 */
export function actionFor(model: string, operation: string): string {
  const verb = operation
    .replace(/Many$/, '')
    .replace('upsert', 'update');
  return `${model.charAt(0).toLowerCase()}${model.slice(1)}.${verb}`;
}

/** Operations that change exactly one identified row. */
export function isSingleRowOperation(operation: string): boolean {
  return operation === 'update' || operation === 'delete' || operation === 'upsert';
}

/**
 * Pull the record id out of a Prisma `where`, when it is a plain id lookup.
 *
 * Returns null for a compound or filtered where, which is honest: those can
 * match many rows, and claiming one id would be worse than claiming none.
 */
export function idFromWhere(where: unknown): string | null {
  if (!where || typeof where !== 'object') return null;
  const id = (where as Record<string, unknown>).id;
  return typeof id === 'string' ? id : null;
}

export interface AuditHooks {
  /** Read the row as it stands, before a change. */
  readBefore(model: string, id: string): Promise<unknown>;
  record(event: {
    action: string;
    entity: string;
    entityId: string | null;
    oldValues?: unknown;
    newValues?: unknown;
  }): Promise<void>;
  onError(message: string, err: unknown): void;
}

/**
 * Build the extension. Takes its collaborators as arguments so the behaviour
 * can be tested without a database.
 */
export function createAuditExtension(hooks: AuditHooks) {
  return Prisma.defineExtension({
    name: 'audit-trail',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!isAuditedModel(model) || !isAuditedOperation(operation)) {
            return query(args);
          }

          const where = (args as { where?: unknown } | undefined)?.where;
          const id = idFromWhere(where);

          // Capture the before-state for a single-row change. One extra read
          // on updates and deletes, which is the price of being able to say
          // what a value *was* - the question an auditor actually asks.
          let oldValues: unknown;
          if (id && isSingleRowOperation(operation)) {
            try {
              oldValues = await hooks.readBefore(model as string, id);
            } catch (err) {
              // Not fatal: better an audit row without the old value than a
              // failed business operation.
              hooks.onError(`audit could not read ${model}:${id} before change`, err);
            }
          }
          if (operation === 'delete' && !oldValues && id) {
            oldValues = { id };
          }

          const result = await query(args);

          try {
            const newValues =
              operation === 'delete' || operation === 'deleteMany'
                ? undefined
                : extractNewValues(result, args);

            await hooks.record({
              action: actionFor(model as string, operation),
              entity: model as string,
              entityId: id ?? extractResultId(result),
              oldValues,
              newValues,
            });
          } catch (err) {
            hooks.onError(`audit record failed for ${model}.${operation}`, err);
          }

          return result;
        },
      },
    },
  });
}

/**
 * What to store as the new state.
 *
 * Prefers the returned row, which is what was actually written; falls back to
 * the submitted `data` for the bulk operations that return only a count.
 */
function extractNewValues(result: unknown, args: unknown): unknown {
  if (result && typeof result === 'object' && !Array.isArray(result) && 'id' in result) {
    return result;
  }
  const data = (args as { data?: unknown } | undefined)?.data;
  return data ?? undefined;
}

function extractResultId(result: unknown): string | null {
  if (result && typeof result === 'object' && 'id' in result) {
    const id = (result as { id: unknown }).id;
    return typeof id === 'string' ? id : null;
  }
  return null;
}
