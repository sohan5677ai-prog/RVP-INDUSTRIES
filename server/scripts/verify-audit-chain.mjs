/**
 * Verify the audit trail's hash chain from the command line.
 *
 *   node scripts/verify-audit-chain.mjs
 *
 * There is also an endpoint for this (POST /api/audit-log/verify), and that is
 * the one people will actually use. This exists for the cases the endpoint
 * cannot serve: handing an auditor a result produced without going through the
 * application, and checking a database the app is not running against.
 *
 * Exits 0 when the chain is intact, 1 when it is not - so it can be a cron job
 * or a CI step without anyone reading the output.
 *
 * Deliberately standalone JavaScript rather than importing the server's
 * TypeScript: a verifier that needs the application to build is one that
 * cannot be run when the application is broken, which is exactly when someone
 * will want it.
 */
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

const GENESIS_HASH = '0'.repeat(64);
const BATCH = 1000;

/** Must match canonicalise() in src/lib/auditChain.ts exactly. */
function canonicalise(value) {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashRow(row, prevHash) {
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

const prisma = new PrismaClient();
const failures = [];
let checked = 0;
let prevHash = GENESIS_HASH;
let expectedSeq = null;
let cursor = 0n;

try {
  for (;;) {
    const rows = await prisma.auditLog.findMany({
      where: { seq: { gt: cursor } },
      orderBy: { seq: 'asc' },
      take: BATCH,
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      const seq = BigInt(row.seq);
      if (expectedSeq !== null && seq !== expectedSeq) {
        failures.push(`gap: expected seq ${expectedSeq}, found ${seq}`);
      }
      expectedSeq = seq + 1n;

      if (row.prevHash !== prevHash) {
        failures.push(`broken link at seq ${seq}: prevHash does not match the row before it`);
      }
      const expected = hashRow(row, row.prevHash);
      if (expected !== row.hash) {
        failures.push(`altered row at seq ${seq}: stored hash does not match its contents`);
      }
      prevHash = row.hash;
      checked++;
    }

    cursor = BigInt(rows[rows.length - 1].seq);
    if (rows.length < BATCH) break;
  }

  if (failures.length === 0) {
    console.log(`audit chain intact: ${checked} rows verified`);
    process.exit(0);
  }

  console.error(`audit chain BROKEN: ${failures.length} problem(s) across ${checked} rows\n`);
  for (const f of failures.slice(0, 50)) console.error(`  ${f}`);
  if (failures.length > 50) console.error(`  ...and ${failures.length - 50} more`);
  console.error('\nA break means a row was altered, removed or inserted after it was written.');
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
