/**
 * The nightly storage sweep (Phase 5).
 *
 * The job itself is thin - the safety lives in the classification, which
 * fileRetention.test.ts covers. What is worth pinning here is the behaviour
 * that only exists because this runs unattended: that it records having run
 * even when it removes nothing, and that a failure is logged rather than
 * thrown onward.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const planRetention = vi.fn();
const applyRetention = vi.fn();
vi.mock('../services/fileRetention.service.js', () => ({
  planRetention: () => planRetention(),
  applyRetention: (p: unknown) => applyRetention(p),
  bytesOf: (o: { size: number }[]) => o.reduce((a, x) => a + x.size, 0),
  MEDIA_RETENTION_DAYS: 7,
  ORPHAN_GRACE_HOURS: 48,
}));

const recordAudit = vi.fn();
vi.mock('../services/audit.service.js', () => ({ recordAudit: (e: unknown) => recordAudit(e) }));
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('../lib/logger.js', () => ({ logger }));

const { runStoragePrune } = await import('./storagePruneJob.js');

const obj = (name: string, size = 1_000_000) => ({ name, size, createdAt: new Date() });

const emptyPlan = {
  total: { count: 134, bytes: 81_000_000 },
  protectedByRow: { count: 104, bytes: 33_000_000 },
  recentMedia: { count: 16, bytes: 43_000_000 },
  tooNewToJudge: { count: 14, bytes: 3_000_000 },
  deleteExpiredMedia: [],
  deleteOrphans: [],
};

beforeEach(() => vi.clearAllMocks());

describe('when there is nothing to remove', () => {
  beforeEach(() => planRetention.mockResolvedValue(emptyPlan));

  it('deletes nothing', async () => {
    await runStoragePrune();
    expect(applyRetention).not.toHaveBeenCalled();
  });

  it('still records that it ran', async () => {
    // An unattended job that removes data should leave a record of having
    // run, so a quiet night is distinguishable from a job that never fired.
    await runStoragePrune();
    expect(recordAudit).toHaveBeenCalledOnce();
    expect(recordAudit.mock.calls[0][0].action).toBe('storage.prune');
    expect(recordAudit.mock.calls[0][0].newValues.deleted).toBe(0);
  });
});

describe('when there is something to remove', () => {
  beforeEach(() => {
    planRetention.mockResolvedValue({
      ...emptyPlan,
      deleteExpiredMedia: [obj('sent.pdf', 5_000_000)],
      deleteOrphans: [obj('orphan.jpg', 1_000_000)],
    });
    applyRetention.mockResolvedValue({ deleted: 2, bytes: 6_000_000, failed: [] });
  });

  it('removes them and reports the totals', async () => {
    const r = await runStoragePrune();
    expect(applyRetention).toHaveBeenCalledOnce();
    expect(r).toEqual({ deleted: 2, bytes: 6_000_000 });
  });

  it('records both reasons separately, since they are different decisions', async () => {
    await runStoragePrune();
    const v = recordAudit.mock.calls[0][0].newValues;
    expect(v.orphans).toBe(1);
    expect(v.expiredMedia).toBe(1);
    expect(v.deleted).toBe(2);
    // The policy that produced this outcome, so a later reader knows which
    // windows were in force at the time.
    expect(v.retentionDays).toBe(7);
    expect(v.orphanGraceHours).toBe(48);
  });

  it('records a partial failure rather than hiding it', async () => {
    applyRetention.mockResolvedValue({ deleted: 1, bytes: 1_000_000, failed: ['sent.pdf'] });
    await runStoragePrune();
    expect(recordAudit.mock.calls[0][0].newValues.failed).toBe(1);
  });
});

describe('when it goes wrong', () => {
  it('lets a planning refusal propagate to the caller, which logs it', async () => {
    // planRetention refuses if nothing in the bucket is referenced, because
    // that means the queries are broken rather than the files unused. The
    // cron wrapper catches and logs; it must not be swallowed here, where it
    // would look like a successful empty run.
    planRetention.mockRejectedValue(new Error('no stored file is referenced by any row'));
    await expect(runStoragePrune()).rejects.toThrow(/not referenced|no stored file/);
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
