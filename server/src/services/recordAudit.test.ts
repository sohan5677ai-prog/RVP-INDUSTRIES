/**
 * The assertion at the call site (Phase 4, plan items 4.1-4.3).
 *
 * Two different versions of one mistake made the live chain unverifiable, and
 * neither was a hashing bug - `hashRow` was always correct. The bug was that
 * `recordAudit` hashed one payload and wrote a different one:
 *
 *   1. values carrying a Decimal hashed as {d,e,s} and were stored as a number
 *   2. credential fields hashed in the clear and were stored as '[redacted]'
 *   3. userId hashed from context.userId, stored as onBehalfOf?.userId ?? it
 *
 * A round-trip test over `redact` catches (1) but cannot catch (2) or (3),
 * because those are not round-trip failures - the hashed value and the stored
 * value are simply different values. The only assertion that covers all three,
 * and anything of the same shape added later, is this one: take the row
 * `recordAudit` actually wrote, re-hash it from its own stored columns, and
 * require the result to equal the hash it stored alongside them.
 *
 * That is precisely what the verifier does in production, so a row that passes
 * here cannot report as tampered there.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const context: { current: Record<string, unknown> | undefined } = { current: undefined };
vi.mock('../lib/requestContext.js', () => ({
  currentContext: () => context.current,
}));

const created: Record<string, any>[] = [];
const tail: { rows: { seq: bigint; hash: string }[] } = { rows: [] };

const tx = {
  $queryRaw: vi.fn(async () => tail.rows),
  auditLog: { create: vi.fn(async ({ data }: { data: Record<string, any> }) => { created.push(data); }) },
};

vi.mock('../lib/prisma.js', () => ({
  prisma: { $transaction: (fn: (t: unknown) => Promise<void>) => fn(tx) },
  registerAuditHooks: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

const { recordAudit } = await import('./audit.service.js');
const { hashRow, GENESIS_HASH } = await import('../lib/auditChain.js');

/**
 * Re-hash a written row from its own stored columns - exactly what the
 * verifier does after reading it back out of Postgres, including the JSON
 * round-trip the column performs.
 */
function rehash(data: Record<string, any>): string {
  const asStored = (v: unknown) =>
    v === Prisma.JsonNull || v === null || v === undefined ? null : JSON.parse(JSON.stringify(v));
  return hashRow(
    {
      seq: data.seq,
      action: data.action,
      entity: data.entity,
      entityId: data.entityId,
      oldValues: asStored(data.oldValues),
      newValues: asStored(data.newValues),
      userId: data.userId,
      ip: data.ip,
      requestId: data.requestId,
      createdAt: data.createdAt,
    },
    data.prevHash
  );
}

beforeEach(() => {
  created.length = 0;
  tail.rows = [];
  context.current = undefined;
  vi.clearAllMocks();
});

describe('recordAudit writes a row that verifies', () => {
  it('for a payload carrying a Decimal', async () => {
    // The exact shape that failed in production: Account.openingBalance.
    await recordAudit({
      action: 'account.update',
      entity: 'Account',
      entityId: 'acc1',
      newValues: { code: '50080', name: 'Interest Expense', openingBalance: new Prisma.Decimal(0) },
    });
    expect(created).toHaveLength(1);
    expect(rehash(created[0])).toBe(created[0].hash);
  });

  it('for a payload carrying money with paise', async () => {
    await recordAudit({
      action: 'payment.create',
      entity: 'Payment',
      entityId: 'p1',
      newValues: { amount: new Prisma.Decimal('123456.78'), weight: new Prisma.Decimal('29.555') },
    });
    expect(rehash(created[0])).toBe(created[0].hash);
  });

  it('for a payload carrying credentials that get redacted', async () => {
    // The second failure in production: User.update rows. These hashed the
    // hash in the clear and stored '[redacted]', so they could never verify.
    await recordAudit({
      action: 'user.update',
      entity: 'User',
      entityId: 'u1',
      oldValues: { username: 'sohan', password: '$argon2id$v=19$old', mfaSecret: 'JBSWY3DPOLD' },
      newValues: { username: 'sohan', password: '$argon2id$v=19$new', mfaSecret: 'JBSWY3DPNEW' },
    });
    expect(rehash(created[0])).toBe(created[0].hash);
    // And the credentials really are gone, not merely hashed consistently.
    expect(created[0].newValues.password).toBe('[redacted]');
    expect(created[0].newValues.mfaSecret).toBe('[redacted]');
  });

  it('for a write made on behalf of someone else', async () => {
    // The third, which nothing had exercised: the Slack bot and the kata
    // cabin act for a user, and userId was hashed before that substitution.
    context.current = {
      userId: 'service-bot',
      userName: 'Slack bot',
      onBehalfOf: { userId: 'u-real', userName: 'Sohan' },
      ip: '10.0.0.5',
      requestId: 'req-1',
      method: 'POST',
      path: '/api/po',
    };
    await recordAudit({ action: 'purchaseOrder.create', entity: 'PurchaseOrder', entityId: 'po1' });
    expect(created[0].userId).toBe('u-real');
    expect(rehash(created[0])).toBe(created[0].hash);
  });

  it('for a create, where there is no before-state', async () => {
    await recordAudit({ action: 'party.create', entity: 'Party', entityId: 'pt1', newValues: { name: 'KNM' } });
    // Stored as the Prisma null sentinel, hashed as plain null - the one place
    // those two must be kept apart.
    expect(created[0].oldValues).toBe(Prisma.JsonNull);
    expect(rehash(created[0])).toBe(created[0].hash);
  });

  it('for a value long enough to be truncated', async () => {
    await recordAudit({ action: 'note.update', entity: 'UserNote', entityId: 'n1', newValues: { content: 'x'.repeat(5000) } });
    expect(rehash(created[0])).toBe(created[0].hash);
  });

  it('and links onto the row before it rather than restarting the chain', async () => {
    tail.rows = [{ seq: 41n, hash: 'a'.repeat(64) }];
    await recordAudit({ action: 'party.update', entity: 'Party', entityId: 'pt1', newValues: { name: 'X' } });
    expect(created[0].seq).toBe(42n);
    expect(created[0].prevHash).toBe('a'.repeat(64));
    expect(rehash(created[0])).toBe(created[0].hash);
  });

  it('starts at genesis on an empty table', async () => {
    await recordAudit({ action: 'auth.login' });
    expect(created[0].seq).toBe(1n);
    expect(created[0].prevHash).toBe(GENESIS_HASH);
    expect(rehash(created[0])).toBe(created[0].hash);
  });
});
