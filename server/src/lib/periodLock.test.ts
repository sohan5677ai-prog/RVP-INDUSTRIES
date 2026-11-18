import { describe, it, expect } from 'vitest';
import { lockCovering, overlaps } from './periodLock.js';

const d = (iso: string) => new Date(iso);
const range = (from: string, to: string, reason: string | null = null) => ({
  from: d(from).getTime(),
  to: d(to).getTime(),
  reason,
});

/** FY 2025-26 closed, plus April 2026 closed separately. */
const LOCKS = [
  range('2025-04-01T00:00:00+05:30', '2026-03-31T23:59:59+05:30', 'FY 2025-26 filed'),
  range('2026-04-01T00:00:00+05:30', '2026-04-30T23:59:59+05:30', 'April closed'),
];

describe('lockCovering', () => {
  it('finds the lock a date falls inside', () => {
    expect(lockCovering(LOCKS, d('2025-09-15T10:00:00+05:30'))?.reason).toBe('FY 2025-26 filed');
    expect(lockCovering(LOCKS, d('2026-04-15T10:00:00+05:30'))?.reason).toBe('April closed');
  });

  it('is inclusive at both ends', () => {
    // A posting on the last day of a closed month must be refused, not
    // squeaked through by an off-by-one.
    expect(lockCovering(LOCKS, d('2025-04-01T00:00:00+05:30'))).not.toBeNull();
    expect(lockCovering(LOCKS, d('2026-03-31T23:59:59+05:30'))).not.toBeNull();
  });

  it('returns null for an open date', () => {
    expect(lockCovering(LOCKS, d('2026-05-01T00:00:00+05:30'))).toBeNull();
    expect(lockCovering(LOCKS, d('2025-03-31T23:59:59+05:30'))).toBeNull();
  });

  it('returns null when nothing is locked', () => {
    expect(lockCovering([], d('2026-01-01T00:00:00+05:30'))).toBeNull();
  });

  it('reads the boundary in IST, not the server clock', () => {
    // 2026-04-01T00:30+05:30 is 2026-03-31T19:00Z. Treated as UTC it would
    // fall in the closed financial year; in IST it is April and open-ish.
    // The lock ranges are built from IST instants, so the comparison is
    // against those - this pins that the ranges, not the process clock, decide.
    const justAfterFyEnd = d('2026-04-01T00:30:00+05:30');
    expect(lockCovering(LOCKS, justAfterFyEnd)?.reason).toBe('April closed');
  });
});

describe('overlaps', () => {
  it('detects a proposed lock that collides with an existing one', () => {
    expect(
      overlaps(LOCKS, d('2026-03-01T00:00:00+05:30'), d('2026-03-31T23:59:59+05:30'))
    ).toBe(true);
  });

  it('detects a proposal that merely touches the edge', () => {
    expect(
      overlaps(LOCKS, d('2026-03-31T23:59:59+05:30'), d('2026-06-30T23:59:59+05:30'))
    ).toBe(true);
  });

  it('allows a clear gap', () => {
    expect(
      overlaps(LOCKS, d('2026-05-01T00:00:00+05:30'), d('2026-05-31T23:59:59+05:30'))
    ).toBe(false);
  });

  it('allows anything when nothing is locked', () => {
    expect(overlaps([], d('2020-01-01T00:00:00Z'), d('2030-01-01T00:00:00Z'))).toBe(false);
  });
});
