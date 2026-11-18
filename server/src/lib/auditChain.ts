import { createHash } from 'node:crypto';

/**
 * The audit log's hash chain (plan item 4.3).
 *
 * Each row hashes its own contents together with the previous row's hash, so
 * changing or removing any row breaks every hash after it. Verification walks
 * the chain and reports the first break.
 *
 * What this does and does not give you, stated plainly because the difference
 * matters to an auditor:
 *
 * - It **detects** tampering, including a deletion, after the fact.
 * - It does **not prevent** it. Anyone who can write to the table can also
 *   recompute the chain. Prevention is `REVOKE UPDATE, DELETE` from the
 *   application role, and the chain is what catches a superuser who edits rows
 *   without bothering to rebuild it.
 * - It is **not a signature**. There is no secret here, so it proves internal
 *   consistency, not authorship. Keyed hashing would tie the chain to the
 *   server's secret, but then rotating JWT_SECRET would invalidate the whole
 *   history, which is a worse trade for this deployment.
 */

/** Hash stored on the first row, where there is no predecessor. */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * The fields that go into a row's hash.
 *
 * Deliberately explicit rather than "everything on the row": adding a column
 * later must not silently change how existing rows hash, which would read as
 * tampering across the whole table.
 */
export interface ChainableRow {
  seq: bigint | number;
  action: string;
  entity?: string | null;
  entityId?: string | null;
  oldValues?: unknown;
  newValues?: unknown;
  userId?: string | null;
  ip?: string | null;
  requestId?: string | null;
  createdAt: Date;
}

/**
 * Serialise a value stably, so the same content always hashes the same way.
 *
 * Object keys are sorted recursively: `{a:1,b:2}` and `{b:2,a:1}` are the same
 * fact, and JSON.stringify alone would hash them differently depending on
 * insertion order - which would make the chain fail verification for no
 * reason at all.
 */
export function canonicalise(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The hash for a row, given the hash of the row before it. */
export function hashRow(row: ChainableRow, prevHash: string): string {
  const payload = canonicalise({
    seq: String(row.seq),
    action: row.action,
    entity: row.entity ?? null,
    entityId: row.entityId ?? null,
    oldValues: row.oldValues ?? null,
    newValues: row.newValues ?? null,
    userId: row.userId ?? null,
    ip: row.ip ?? null,
    requestId: row.requestId ?? null,
    createdAt: row.createdAt,
  });
  return createHash('sha256').update(`${prevHash}:${payload}`).digest('hex');
}

export interface StoredRow extends ChainableRow {
  hash: string;
  prevHash: string;
}

export type VerifyFailure =
  | { kind: 'bad-genesis'; seq: string }
  | { kind: 'broken-link'; seq: string; expectedPrev: string; actualPrev: string }
  | { kind: 'bad-hash'; seq: string; expected: string; actual: string }
  | { kind: 'gap'; seq: string; expectedSeq: string };

export interface VerifyResult {
  ok: boolean;
  checked: number;
  /** Every problem found, not only the first - a single break is one story, a */
  /** hundred is another, and stopping at the first would not tell them apart. */
  failures: VerifyFailure[];
}

/**
 * Walk a run of rows in seq order and check the chain.
 *
 * `expectedFirstPrev` lets a caller verify a slice rather than the whole table:
 * pass the hash of the row before the slice, or GENESIS_HASH when starting at
 * the beginning.
 */
export function verifyChain(
  rows: StoredRow[],
  expectedFirstPrev: string = GENESIS_HASH
): VerifyResult {
  const failures: VerifyFailure[] = [];
  let prevHash = expectedFirstPrev;
  let expectedSeq: bigint | null = null;

  for (const row of rows) {
    const seq = BigInt(row.seq);

    // A gap means a row was removed. The chain alone would not catch a
    // deletion at the end of the table, so the sequence is checked too.
    if (expectedSeq !== null && seq !== expectedSeq) {
      failures.push({ kind: 'gap', seq: String(seq), expectedSeq: String(expectedSeq) });
    }
    expectedSeq = seq + 1n;

    if (row.prevHash !== prevHash) {
      failures.push(
        prevHash === GENESIS_HASH && row.prevHash !== GENESIS_HASH
          ? { kind: 'bad-genesis', seq: String(seq) }
          : {
              kind: 'broken-link',
              seq: String(seq),
              expectedPrev: prevHash,
              actualPrev: row.prevHash,
            }
      );
    }

    const expected = hashRow(row, row.prevHash);
    if (expected !== row.hash) {
      failures.push({ kind: 'bad-hash', seq: String(seq), expected, actual: row.hash });
    }

    // Continue from what the row claims, so one altered row reports one
    // failure rather than cascading a false break through everything after.
    prevHash = row.hash;
  }

  return { ok: failures.length === 0, checked: rows.length, failures };
}
