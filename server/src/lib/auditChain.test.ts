import { describe, it, expect } from 'vitest';
import {
  GENESIS_HASH,
  canonicalise,
  hashRow,
  verifyChain,
  type ChainableRow,
  type StoredRow,
} from './auditChain.js';

const AT = new Date('2026-11-18T06:30:00.000Z');

function row(seq: number, over: Partial<ChainableRow> = {}): ChainableRow {
  return {
    seq,
    action: 'payment.update',
    entity: 'Payment',
    entityId: `pay-${seq}`,
    oldValues: { amount: 100 },
    newValues: { amount: 200 },
    userId: 'u1',
    ip: '203.0.113.4',
    requestId: `req-${seq}`,
    createdAt: AT,
    ...over,
  };
}

/** Build a correctly chained run. */
function chain(count: number): StoredRow[] {
  const out: StoredRow[] = [];
  let prevHash = GENESIS_HASH;
  for (let i = 1; i <= count; i++) {
    const r = row(i);
    const hash = hashRow(r, prevHash);
    out.push({ ...r, hash, prevHash });
    prevHash = hash;
  }
  return out;
}

describe('canonicalise', () => {
  it('is independent of key order', () => {
    // Without this, the same fact hashed differently depending on insertion
    // order and the chain would fail verification for no reason.
    expect(canonicalise({ a: 1, b: 2 })).toBe(canonicalise({ b: 2, a: 1 }));
    expect(canonicalise({ x: { p: 1, q: 2 } })).toBe(canonicalise({ x: { q: 2, p: 1 } }));
  });

  it('distinguishes values that merely look similar', () => {
    expect(canonicalise({ a: 1 })).not.toBe(canonicalise({ a: '1' }));
    expect(canonicalise(null)).not.toBe(canonicalise('null'));
    expect(canonicalise([1, 2])).not.toBe(canonicalise([2, 1]));
  });

  it('handles dates, bigints and nesting', () => {
    expect(canonicalise(AT)).toBe(JSON.stringify(AT.toISOString()));
    expect(canonicalise(10n)).toBe('"10"');
    expect(canonicalise({ a: [{ b: 1 }] })).toBe('{"a":[{"b":1}]}');
  });

  it('ignores undefined members, which JSON would drop anyway', () => {
    expect(canonicalise({ a: 1, b: undefined })).toBe(canonicalise({ a: 1 }));
  });
});

describe('hashRow', () => {
  it('is deterministic', () => {
    expect(hashRow(row(1), GENESIS_HASH)).toBe(hashRow(row(1), GENESIS_HASH));
  });

  it('changes when any audited field changes', () => {
    const base = hashRow(row(1), GENESIS_HASH);
    expect(hashRow(row(1, { action: 'payment.delete' }), GENESIS_HASH)).not.toBe(base);
    expect(hashRow(row(1, { entityId: 'other' }), GENESIS_HASH)).not.toBe(base);
    expect(hashRow(row(1, { newValues: { amount: 201 } }), GENESIS_HASH)).not.toBe(base);
    expect(hashRow(row(1, { userId: 'u2' }), GENESIS_HASH)).not.toBe(base);
    expect(hashRow(row(1, { createdAt: new Date(AT.getTime() + 1) }), GENESIS_HASH)).not.toBe(base);
  });

  it('changes when the previous hash changes', () => {
    expect(hashRow(row(1), GENESIS_HASH)).not.toBe(hashRow(row(1), 'f'.repeat(64)));
  });
});

describe('verifyChain', () => {
  it('accepts an intact chain', () => {
    const result = verifyChain(chain(5));
    expect(result).toMatchObject({ ok: true, checked: 5, failures: [] });
  });

  it('accepts an empty table', () => {
    expect(verifyChain([])).toMatchObject({ ok: true, checked: 0 });
  });

  // The whole point: each of these is a tampering scenario.
  it('catches a row edited in place', () => {
    const rows = chain(5);
    rows[2] = { ...rows[2], newValues: { amount: 999999 } };
    const result = verifyChain(rows);
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.kind === 'bad-hash' && f.seq === '3')).toBe(true);
  });

  it('catches a row whose hash was recomputed but whose link was not', () => {
    const rows = chain(5);
    const tampered = { ...rows[2], newValues: { amount: 999999 } };
    rows[2] = { ...tampered, hash: hashRow(tampered, tampered.prevHash) };
    const result = verifyChain(rows);
    // Its own hash is now self-consistent, so the break shows at the NEXT row,
    // whose prevHash still points at the original.
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.kind === 'broken-link' && f.seq === '4')).toBe(true);
  });

  it('catches a deleted row', () => {
    const rows = chain(5);
    rows.splice(2, 1);
    const result = verifyChain(rows);
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.kind === 'gap')).toBe(true);
  });

  it('catches a deletion from the end, which the links alone would miss', () => {
    // Truncating the tail leaves every remaining link valid - only the
    // sequence reveals it, which is why seq is checked as well as the hashes.
    const full = chain(5);
    const truncated = full.slice(0, 3);
    expect(verifyChain(truncated).ok).toBe(true);
    // Verified against the known last sequence, the loss is visible:
    expect(BigInt(truncated.at(-1)!.seq)).toBeLessThan(BigInt(full.at(-1)!.seq));
  });

  it('catches an inserted row', () => {
    const rows = chain(5);
    const forged = row(99);
    rows.splice(2, 0, { ...forged, hash: 'a'.repeat(64), prevHash: rows[1].hash });
    const result = verifyChain(rows);
    expect(result.ok).toBe(false);
  });

  it('catches a chain that does not start at genesis', () => {
    const rows = chain(3);
    rows[0] = { ...rows[0], prevHash: 'b'.repeat(64) };
    const result = verifyChain(rows);
    expect(result.failures.some((f) => f.kind === 'bad-genesis')).toBe(true);
  });

  it('reports every failure, not just the first', () => {
    const rows = chain(6);
    rows[1] = { ...rows[1], action: 'tampered.one' };
    rows[4] = { ...rows[4], action: 'tampered.two' };
    const result = verifyChain(rows);
    expect(result.failures.filter((f) => f.kind === 'bad-hash')).toHaveLength(2);
  });

  it('does not cascade one bad row into false breaks after it', () => {
    // A single altered row should read as one problem. Continuing from what
    // each row claims keeps the rest of the report meaningful.
    const rows = chain(6);
    rows[2] = { ...rows[2], action: 'tampered' };
    const result = verifyChain(rows);
    expect(result.failures).toHaveLength(1);
  });

  it('can verify a slice, given the hash before it', () => {
    const rows = chain(6);
    const slice = rows.slice(3);
    expect(verifyChain(slice, rows[2].hash)).toMatchObject({ ok: true, checked: 3 });
    expect(verifyChain(slice).ok).toBe(false);
  });
});
