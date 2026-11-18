import { describe, it, expect } from 'vitest';
import {
  actionFor,
  idFromWhere,
  isAuditedModel,
  isAuditedOperation,
  isSingleRowOperation,
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
