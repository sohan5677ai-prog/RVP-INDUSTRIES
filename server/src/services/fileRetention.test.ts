/**
 * Deciding which stored files may be deleted (Phase 5).
 *
 * This function's mistakes are unrecoverable, so the classification is pure
 * and tested on its own. The tests that matter are not the ones proving it
 * deletes - they are the ones proving what it refuses to touch.
 */
import { describe, it, expect } from 'vitest';
import { classifyObjects, type StoredObject } from './fileRetention.service.js';

const NOW = new Date('2026-11-19T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 3600 * 1000);
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600 * 1000);

const obj = (name: string, createdAt: Date, size = 1_000_000): StoredObject => ({
  name,
  size,
  createdAt,
});

const plan = (p: {
  objects: StoredObject[];
  protectedNames?: string[];
  sentMedia?: [string, Date][];
}) =>
  classifyObjects({
    objects: p.objects,
    protectedNames: new Set(p.protectedNames ?? []),
    sentMedia: new Map(p.sentMedia ?? []),
    now: NOW,
  });

const names = (o: StoredObject[]) => o.map((x) => x.name).sort();

describe('what it must never delete', () => {
  it('keeps anything a row points at, however old', () => {
    // A kata slip from last year is still the only copy of that slip.
    const o = obj('kata.jpg', daysAgo(400));
    const r = plan({ objects: [o], protectedNames: ['kata.jpg'] });
    expect(r.deleteOrphans).toEqual([]);
    expect(r.deleteExpiredMedia).toEqual([]);
    expect(r.protectedByRow.count).toBe(1);
  });

  it('keeps a protected file even when a send log also references it', () => {
    // A kata slip that was also WhatsApped is still a kata slip. The
    // protected check has to win, and it is tested because getting the
    // precedence backwards would delete real uploads.
    const o = obj('both.jpg', daysAgo(400));
    const r = plan({
      objects: [o],
      protectedNames: ['both.jpg'],
      sentMedia: [['both.jpg', daysAgo(300)]],
    });
    expect(r.deleteExpiredMedia).toEqual([]);
    expect(r.protectedByRow.count).toBe(1);
  });

  it('keeps a recently uploaded file that nothing points at yet', () => {
    // THE important one. A file is uploaded before the row that references it
    // is written, so every upload is briefly an orphan. Without the grace
    // window this deletes a kata slip a second after it arrives.
    const r = plan({ objects: [obj('just-arrived.jpg', hoursAgo(1))] });
    expect(r.deleteOrphans).toEqual([]);
    expect(r.tooNewToJudge.count).toBe(1);
  });

  it('keeps a sent document still inside its retention window', () => {
    const r = plan({
      objects: [obj('statement.pdf', daysAgo(10))],
      sentMedia: [['statement.pdf', daysAgo(2)]],
    });
    expect(r.deleteExpiredMedia).toEqual([]);
    expect(r.recentMedia.count).toBe(1);
  });

  it('judges a document by when it was last sent, not when it was uploaded', () => {
    // An old file re-sent yesterday is still live.
    const r = plan({
      objects: [obj('ledger.pdf', daysAgo(300))],
      sentMedia: [['ledger.pdf', daysAgo(1)]],
    });
    expect(r.deleteExpiredMedia).toEqual([]);
  });
});

describe('what it does delete', () => {
  it('removes a sent document past its retention window', () => {
    const r = plan({
      objects: [obj('old-statement.pdf', daysAgo(90))],
      sentMedia: [['old-statement.pdf', daysAgo(30)]],
    });
    expect(names(r.deleteExpiredMedia)).toEqual(['old-statement.pdf']);
  });

  it('removes an old file that nothing references', () => {
    const r = plan({ objects: [obj('orphan.jpg', daysAgo(60))] });
    expect(names(r.deleteOrphans)).toEqual(['orphan.jpg']);
  });

  it('separates the two reasons, since they are different decisions', () => {
    // Orphans are safe without any retention policy; expired media is a
    // policy choice. The caller may want one and not the other.
    const r = plan({
      objects: [obj('a.pdf', daysAgo(90)), obj('b.jpg', daysAgo(90))],
      sentMedia: [['a.pdf', daysAgo(30)]],
    });
    expect(names(r.deleteExpiredMedia)).toEqual(['a.pdf']);
    expect(names(r.deleteOrphans)).toEqual(['b.jpg']);
  });
});

describe('the boundaries', () => {
  it('keeps a document sent exactly at the cutoff', () => {
    const r = plan({
      objects: [obj('edge.pdf', daysAgo(30))],
      sentMedia: [['edge.pdf', daysAgo(7)]],
    });
    expect(r.deleteExpiredMedia).toEqual([]);
  });

  it('deletes one sent a minute past it', () => {
    const justOver = new Date(daysAgo(7).getTime() - 60_000);
    const r = plan({ objects: [obj('edge.pdf', daysAgo(30))], sentMedia: [['edge.pdf', justOver]] });
    expect(names(r.deleteExpiredMedia)).toEqual(['edge.pdf']);
  });

  it('keeps an unreferenced file exactly at the grace boundary', () => {
    const r = plan({ objects: [obj('edge.jpg', hoursAgo(48))] });
    expect(r.deleteOrphans).toEqual([]);
  });
});

describe('the reported totals', () => {
  it('account for every object exactly once', () => {
    const objects = [
      obj('kept.jpg', daysAgo(400)),
      obj('recent-send.pdf', daysAgo(10)),
      obj('expired-send.pdf', daysAgo(90)),
      obj('orphan.jpg', daysAgo(90)),
      obj('too-new.jpg', hoursAgo(2)),
    ];
    const r = plan({
      objects,
      protectedNames: ['kept.jpg'],
      sentMedia: [
        ['recent-send.pdf', daysAgo(1)],
        ['expired-send.pdf', daysAgo(40)],
      ],
    });
    const counted =
      r.protectedByRow.count +
      r.recentMedia.count +
      r.tooNewToJudge.count +
      r.deleteExpiredMedia.length +
      r.deleteOrphans.length;
    expect(counted).toBe(objects.length);
    expect(r.total.count).toBe(objects.length);
    expect(r.total.bytes).toBe(5_000_000);
  });
});
