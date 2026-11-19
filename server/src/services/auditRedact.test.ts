/**
 * The invariant that was missing (Phase 4, plan items 4.1-4.3).
 *
 * The chain tests hashed a row and verified it with the same in-memory object,
 * so they passed while the live chain reported 30 of 40 rows as tampered. The
 * writer hashed the values as Prisma handed them over and stored the redacted
 * copy, and for any row carrying a Decimal the two are different things: a
 * Decimal hashes as {"constructor":undefined,"d":[0],"e":0,"s":1} and comes
 * back out of the JSON column as `0`.
 *
 * What was never asserted is the only thing that matters here: the payload
 * that goes into the hash must survive the trip through the database
 * unchanged. That is what these tests pin, for every type rather than for the
 * list of types someone remembered.
 */
import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { redact } from './audit.service.js';
import { hashRow, GENESIS_HASH } from '../lib/auditChain.js';

/** What the JSON column does to a value on the way out and back. */
const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const row = (values: unknown) => ({
  seq: 1n,
  action: 'account.update',
  entity: 'Account',
  entityId: 'acc1',
  oldValues: null,
  newValues: values,
  userId: null,
  ip: null,
  requestId: null,
  createdAt: new Date('2026-11-18T07:03:26.386Z'),
});

describe('what is hashed is what is stored', () => {
  /**
   * The regression test. Every one of these is a value Prisma hands over in a
   * shape the JSON column will not give back.
   */
  it.each([
    ['a Decimal', { openingBalance: new Prisma.Decimal(0) }],
    ['a Decimal with paise', { amount: new Prisma.Decimal('1234567.89') }],
    ['a Decimal that a float would round', { amount: new Prisma.Decimal('0.1') }],
    ['a Date', { createdAt: new Date('2026-04-01T00:00:00.000Z') }],
    ['a bigint', { seq: 42n }],
    ['nested plain values', { meta: { a: 1, b: [1, 2, 'x'], c: null } }],
    ['a mixture', { amount: new Prisma.Decimal('500.5'), at: new Date(0), n: 7n, ok: true }],
  ])('survives the database round-trip: %s', (_label, values) => {
    const redacted = redact(values);

    // The hash the writer computes, and the hash a verifier computes after
    // reading the row back. These are the two sides that disagreed.
    const atWrite = hashRow(row(redacted), GENESIS_HASH);
    const atVerify = hashRow(row(roundTrip(redacted)), GENESIS_HASH);

    expect(atVerify).toBe(atWrite);
  });

  it('would have caught the bug: hashing the raw value does NOT survive', () => {
    // Guards the test itself. If redact() stopped normalising Decimal, the
    // case above would still pass only if this assertion also changed - so
    // this one pins that the hazard is real and still being handled.
    const raw = { openingBalance: new Prisma.Decimal(0) };
    const atWrite = hashRow(row(raw), GENESIS_HASH);
    const atVerify = hashRow(row(roundTrip(raw)), GENESIS_HASH);
    expect(atVerify).not.toBe(atWrite);
  });
});

describe('redact', () => {
  it('returns plain null, not the Prisma sentinel', () => {
    // Prisma.JsonNull is an object; hashing it would differ from the SQL null
    // the column actually holds.
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeNull();
  });

  it('keeps a Decimal exact rather than going through a float', () => {
    const out = redact({ amount: new Prisma.Decimal('1234567.89') }) as Record<string, unknown>;
    expect(out.amount).toBe('1234567.89');
  });

  it('still strips credentials by field name', () => {
    const out = redact({
      password: 'hunter2',
      mfaSecret: 'JBSWY3DP',
      refreshTokenHash: 'abc',
      name: 'Bikash',
    }) as Record<string, unknown>;
    expect(out.password).toBe('[redacted]');
    expect(out.mfaSecret).toBe('[redacted]');
    expect(out.refreshTokenHash).toBe('[redacted]');
    expect(out.name).toBe('Bikash');
  });

  it('truncates a value too large to be worth keeping', () => {
    const out = redact({ note: 'x'.repeat(3000) }) as Record<string, string>;
    expect(out.note).toHaveLength(2000 + '…[truncated]'.length);
  });
});

/**
 * The same bug, one level down (found 19 Nov 2026).
 *
 * The first fix made `redact` normalise Decimals - but only at the top level.
 * A write that includes a relation carries a nested object: `saleOrder.create`
 * includes `buyer`, a receipt includes `party` and `payer`. A Decimal inside
 * one of those still hashed as {d,e,s} and stored as a number, so eight rows
 * failed verification in production for exactly the original reason.
 *
 * The principle was "hash exactly what is stored". Applying it only to the top
 * level meant it held one level deep, which is the kind of gap a test over
 * flat fixtures cannot see.
 */
describe('nested values survive the round-trip too', () => {
  it.each([
    ['a relation with a Decimal', { id: 's1', buyer: { name: 'Swami', openingBalance: new Prisma.Decimal('1500.50') } }],
    ['two relations, as a receipt has', {
      party: { openingBalance: new Prisma.Decimal(0) },
      payer: { openingBalance: new Prisma.Decimal('99.99') },
    }],
    ['a Decimal inside an array', { lines: [{ amount: new Prisma.Decimal('10.01') }, { amount: new Prisma.Decimal(2) }] }],
    ['three levels down', { a: { b: { c: { amount: new Prisma.Decimal('7.77') } } } }],
    ['a nested Date and bigint', { rel: { at: new Date('2026-04-01T00:00:00.000Z'), seq: 42n } }],
  ])('survives: %s', (_label, values) => {
    const redacted = redact(values);
    const atWrite = hashRow(row(redacted), GENESIS_HASH);
    const atVerify = hashRow(row(JSON.parse(JSON.stringify(redacted))), GENESIS_HASH);
    expect(atVerify).toBe(atWrite);
  });

  it('still strips a credential nested inside a relation', () => {
    const out = redact({ rel: { user: { password: 'hunter2', name: 'Sohan' } } }) as any;
    expect(out.rel.user.password).toBe('[redacted]');
    expect(out.rel.user.name).toBe('Sohan');
  });

  it('survives a cycle rather than overflowing', () => {
    const a: Record<string, unknown> = { amount: new Prisma.Decimal(1) };
    a.self = a;
    expect(() => redact(a)).not.toThrow();
    expect((redact(a) as any).self).toBe('[circular]');
  });
});
