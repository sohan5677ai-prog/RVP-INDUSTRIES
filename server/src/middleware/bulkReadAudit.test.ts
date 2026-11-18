/**
 * Recording large reads (Phase 5, plan item 4).
 *
 * The plan wanted exports gated by `report.export`, audited and watermarked.
 * There are no server-side exports - exceljs and jspdf are client
 * dependencies - so what is tested here is the honest substitute: the fetch
 * that feeds an export, recorded rather than prevented.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const recordAudit = vi.fn();
vi.mock('../services/audit.service.js', () => ({ recordAudit: (e: unknown) => recordAudit(e) }));
const warn = vi.fn();
vi.mock('../lib/logger.js', () => ({ logger: { warn, info: vi.fn(), error: vi.fn() } }));

const { bulkReadAudit, countRows, isAuditable, bulkReadThresholds } = await import(
  './bulkReadAudit.js'
);

const { audit: AUDIT_ROWS, alert: ALERT_ROWS } = bulkReadThresholds();
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}` }));

/** Drive the middleware the way express would, and return what was sent. */
function run(
  body: unknown,
  { method = 'GET', path = '/payments', query = {} as Record<string, string>, userId = 'u1' } = {}
) {
  const sent: unknown[] = [];
  const res = { json: (b: unknown) => { sent.push(b); return res; } } as any;
  const req = { method, path, query, user: { userId, role: 'USER' } } as any;
  bulkReadAudit()(req, res, () => {});
  res.json(body);
  return sent[0];
}

beforeEach(() => vi.clearAllMocks());

describe('countRows', () => {
  it('counts a bare array and the paged envelope', () => {
    expect(countRows([1, 2, 3])).toBe(3);
    expect(countRows({ rows: [1, 2], nextCursor: null })).toBe(2);
    expect(countRows({ items: [1] })).toBe(1);
  });

  it('is null for anything that is not a collection', () => {
    // A single record, a count, a health string - none of them is a bulk read.
    expect(countRows({ id: 'p1', name: 'KNM' })).toBeNull();
    expect(countRows('OK')).toBeNull();
    expect(countRows(null)).toBeNull();
    expect(countRows(42)).toBeNull();
  });
});

describe('what gets recorded', () => {
  it('ignores a response below the threshold', () => {
    run(rows(AUDIT_ROWS - 1));
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('records one at the threshold', () => {
    run(rows(AUDIT_ROWS));
    expect(recordAudit).toHaveBeenCalledOnce();
    expect(recordAudit.mock.calls[0][0].action).toBe('data.bulk_read');
  });

  it('keeps the path and the row count, which is the whole point', () => {
    run(rows(AUDIT_ROWS), { path: '/payments', query: { all: 'true' } });
    const ev = recordAudit.mock.calls[0][0];
    expect(ev.newValues.path).toBe('/payments');
    expect(ev.newValues.rows).toBe(AUDIT_ROWS);
    // `?all=true` is what distinguishes a register dump from a page.
    expect(ev.newValues.query).toContain('all=true');
  });

  it('scrubs the query string, since a filter could carry anything', () => {
    run(rows(AUDIT_ROWS), { query: { all: 'true', token: 'eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.sig_x' } });
    expect(JSON.stringify(recordAudit.mock.calls[0][0])).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('ignores writes, which are already audited row by row', () => {
    // A per-row audit entry is a better record than a count.
    run(rows(AUDIT_ROWS), { method: 'POST' });
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('ignores a single record however large it is', () => {
    run({ id: 'p1', notes: 'x'.repeat(100000) });
    expect(recordAudit).not.toHaveBeenCalled();
  });
});

describe('the alert', () => {
  it('stays quiet at the audit threshold', () => {
    run(rows(AUDIT_ROWS));
    expect(warn).not.toHaveBeenCalled();
  });

  it('shouts at the alert threshold, naming the size and who asked', () => {
    run(rows(ALERT_ROWS), { path: '/payments', userId: 'u-sohan' });
    expect(warn).toHaveBeenCalledOnce();
    const line = warn.mock.calls[0][0] as string;
    expect(line).toContain('[bulk-read]');
    expect(line).toContain(String(ALERT_ROWS));
    expect(line).toContain('/payments');
    expect(line).toContain('u-sohan');
  });
});

describe('it must not break the response it observes', () => {
  it('passes the body through unchanged', () => {
    const body = rows(AUDIT_ROWS);
    expect(run(body)).toBe(body);
  });

  it('still sends the response when recording throws', () => {
    // The trail failing must never cost the user their data.
    recordAudit.mockImplementation(() => {
      throw new Error('audit down');
    });
    const body = rows(AUDIT_ROWS);
    expect(run(body)).toBe(body);
    expect(warn).toHaveBeenCalled();
  });
});
