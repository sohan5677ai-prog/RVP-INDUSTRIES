import { describe, it, expect } from 'vitest';
import {
  actionFor,
  idFromWhere,
  isAuditedModel,
  isAuditedOperation,
  isSingleRowOperation,
  affectedCount,
  isBulkOperation,
} from './auditExtension.js';

describe('which models are audited', () => {
  it('audits the business records', () => {
    for (const m of ['Payment', 'Receipt', 'Party', 'PurchaseOrder', 'SaleOrder', 'User']) {
      expect(isAuditedModel(m), m).toBe(true);
    }
  });

  it('never audits the audit log, which would recurse forever', () => {
    expect(isAuditedModel('AuditLog')).toBe(false);
  });

  it('skips the records that are already a security log', () => {
    // Auditing these would duplicate every entry they exist to hold.
    for (const m of ['LoginAttempt', 'PermissionDenial', 'MasterChangeLog']) {
      expect(isAuditedModel(m), m).toBe(false);
    }
  });

  it('skips high-volume machine telemetry', () => {
    // A GPS ping every 30 seconds per lorry would bury the human actions the
    // trail exists to show.
    for (const m of ['VehiclePing', 'WhatsAppLog', 'PrintJob', 'UserSession']) {
      expect(isAuditedModel(m), m).toBe(false);
    }
  });

  it('treats an unknown model as auditable', () => {
    // Fail towards recording: a table added later is audited until someone
    // decides otherwise, rather than silently escaping the trail.
    expect(isAuditedModel('SomeModelAddedNextYear')).toBe(true);
  });

  it('handles an undefined model name', () => {
    expect(isAuditedModel(undefined)).toBe(false);
  });
});

describe('which operations are audited', () => {
  it('audits every write', () => {
    for (const op of ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']) {
      expect(isAuditedOperation(op), op).toBe(true);
    }
  });

  it('does not audit reads', () => {
    for (const op of ['findUnique', 'findMany', 'findFirst', 'count', 'aggregate', 'groupBy']) {
      expect(isAuditedOperation(op), op).toBe(false);
    }
  });
});

describe('actionFor', () => {
  it('reads like a permission, so a log line and a grant match', () => {
    expect(actionFor('Payment', 'delete')).toBe('payment.delete');
    expect(actionFor('Party', 'update')).toBe('party.update');
    expect(actionFor('PurchaseOrder', 'create')).toBe('purchaseOrder.create');
  });

  it('collapses the bulk variants onto the same verb', () => {
    expect(actionFor('Payment', 'updateMany')).toBe('payment.update');
    expect(actionFor('Payment', 'deleteMany')).toBe('payment.delete');
    expect(actionFor('Payment', 'createMany')).toBe('payment.create');
  });

  it('records an upsert as an update', () => {
    expect(actionFor('Party', 'upsert')).toBe('party.update');
  });
});

describe('idFromWhere', () => {
  it('reads a plain id lookup', () => {
    expect(idFromWhere({ id: 'abc' })).toBe('abc');
  });

  it('returns null for a filter that could match many rows', () => {
    // Claiming one id for a bulk update would be worse than claiming none.
    expect(idFromWhere({ status: 'PENDING' })).toBeNull();
    expect(idFromWhere({ userId_deviceId: { userId: 'u', deviceId: 'd' } })).toBeNull();
    expect(idFromWhere({ id: { in: ['a', 'b'] } })).toBeNull();
  });

  it('handles missing or malformed where clauses', () => {
    expect(idFromWhere(undefined)).toBeNull();
    expect(idFromWhere(null)).toBeNull();
    expect(idFromWhere('id')).toBeNull();
    expect(idFromWhere({})).toBeNull();
  });
});

describe('isSingleRowOperation', () => {
  it('is true only where a before-state can be read for one row', () => {
    expect(isSingleRowOperation('update')).toBe(true);
    expect(isSingleRowOperation('delete')).toBe(true);
    expect(isSingleRowOperation('upsert')).toBe(true);
    expect(isSingleRowOperation('updateMany')).toBe(false);
    expect(isSingleRowOperation('create')).toBe(false);
  });
});

/**
 * Bulk operations that touched nothing (Phase 4 follow-up).
 *
 * A boot-time `updateMany` whose `where` matched no rows was still writing an
 * audit row saying `transportId` had been set. That is not noise, it is a
 * false record - and it ran twice on every server restart.
 */
describe('affectedCount', () => {
  it('reports the count for the operations that return one', () => {
    expect(affectedCount('updateMany', { count: 37 })).toBe(37);
    expect(affectedCount('deleteMany', { count: 0 })).toBe(0);
    expect(affectedCount('createMany', { count: 2 })).toBe(2);
  });

  it('is null for a single-row operation, which has no count to read', () => {
    // null means "record it normally", distinct from 0 which means "drop it".
    expect(affectedCount('update', { id: 'x' })).toBeNull();
    expect(affectedCount('create', { id: 'x' })).toBeNull();
    expect(affectedCount('delete', { id: 'x' })).toBeNull();
  });

  it('records rather than drops a result shape it does not recognise', () => {
    // Failing open: losing an audit row is worse than keeping an odd one.
    expect(affectedCount('updateMany', undefined)).toBeNull();
    expect(affectedCount('updateMany', {})).toBeNull();
    expect(affectedCount('updateMany', { count: '3' })).toBeNull();
  });

  it('distinguishes zero from null, since they mean opposite things', () => {
    expect(affectedCount('updateMany', { count: 0 })).toBe(0);
    expect(affectedCount('updateMany', { count: 0 })).not.toBeNull();
  });
});

describe('isBulkOperation', () => {
  it('names the three that return a count', () => {
    expect(['updateMany', 'deleteMany', 'createMany'].every(isBulkOperation)).toBe(true);
    expect(['update', 'delete', 'create', 'upsert'].some(isBulkOperation)).toBe(false);
  });
});
