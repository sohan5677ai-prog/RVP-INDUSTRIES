/**
 * Re-seal the audit chain in place, deleting nothing.
 *
 *   node scripts/reseal-audit-rows.mjs            # dry run
 *   node scripts/reseal-audit-rows.mjs --apply --confirm=reseal
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SEPARATE FROM reseal-audit-chain.mjs
 *
 * That script was a one-off: it pruned 36 rows of restart noise and compacted
 * `seq`, and its safety checks name the exact rows it was reviewed against, so
 * it refuses to run again. This one does the other half of the job and nothing
 * else - recompute hashes and links for rows that are already there.
 *
 * It exists because a writer bug can make honest rows unverifiable. On 19 Nov
 * 2026 eight rows failed because `redact` normalised Decimals only at the top
 * level, so a Decimal inside an included relation - `buyer` on a sale order,
 * `party` on a receipt - hashed as {d,e,s} and stored as a number. Those rows
 * are real business events, so deleting them would lose an audit record;
 * re-sealing keeps them and makes the chain verifiable again.
 *
 * RECOMPUTING AUDIT HASHES IS WHAT SOMEONE COVERING THEIR TRACKS WOULD DO.
 * That is why it is a script you run deliberately, why it writes a backup
 * first, and why it appends an `audit.reseal` row naming exactly which
 * sequence numbers were broken - so the act is on the record it just rewrote.
 *
 * It REFUSES if `seq` has a gap. A gap is evidence that a row was deleted, and
 * re-sealing would erase that evidence. A break that includes a gap is not a
 * writer bug and must be looked at by a person.
 * ---------------------------------------------------------------------------
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

const GENESIS_HASH = '0'.repeat(64);
const APPLY = process.argv.includes('--apply');
const CONFIRM = (process.argv.find((a) => a.startsWith('--confirm=')) ?? '').split('=')[1] ?? '';

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
  return createHash('sha256')
    .update(
      `${prevHash}:${canonicalise({
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
      })}`
    )
    .digest('hex');
}

const prisma = new PrismaClient();
const die = (msg) => {
  console.error(`\nREFUSED: ${msg}\nNothing was changed.`);
  process.exit(1);
};

try {
  const rows = await prisma.auditLog.findMany({ orderBy: { seq: 'asc' } });
  if (rows.length === 0) {
    console.log('AuditLog is empty; nothing to do.');
    process.exit(0);
  }

  /* -------------------------------------------------------- inspection -- */

  const gaps = [];
  const badHash = [];
  let expectedSeq = BigInt(rows[0].seq);
  let prevHash = GENESIS_HASH;

  for (const r of rows) {
    const seq = BigInt(r.seq);
    if (seq !== expectedSeq) gaps.push(`expected ${expectedSeq}, found ${seq}`);
    expectedSeq = seq + 1n;
    if (hashRow(r, r.prevHash) !== r.hash) badHash.push(String(seq));
    prevHash = r.hash;
  }

  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN - nothing will change'}\n`);
  console.log(`rows            : ${rows.length}  (seq ${rows[0].seq}..${rows[rows.length - 1].seq})`);
  console.log(`unverifiable    : ${badHash.length}${badHash.length ? `  -> ${badHash.join(', ')}` : ''}`);
  console.log(`sequence gaps   : ${gaps.length}`);

  if (gaps.length > 0) {
    die(
      `the sequence has ${gaps.length} gap(s): ${gaps.slice(0, 3).join('; ')}.\n` +
        'A gap means a row was removed, and re-sealing would erase that evidence.\n' +
        'This is not a writer bug. Look at it before doing anything else.'
    );
  }

  if (badHash.length === 0) {
    console.log('\nThe chain already verifies. Nothing to re-seal.');
    process.exit(0);
  }

  console.log(`\nwould re-seal all ${rows.length} rows, keeping every one, and append an audit.reseal row.`);

  if (!APPLY) {
    console.log('\nRe-run with --apply --confirm=reseal to do it.');
    process.exit(0);
  }
  if (CONFIRM !== 'reseal') {
    die('--apply needs --confirm=reseal. Rewriting audit hashes should not happen by muscle memory.');
  }

  /* ------------------------------------------------------------ backup -- */

  mkdirSync('backups', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `backups/auditlog-before-reseal-rows-${stamp}.json`;
  writeFileSync(
    backup,
    JSON.stringify(
      { takenAt: new Date().toISOString(), reason: 'nested-Decimal hashing bug', unverifiable: badHash, rows },
      (_k, v) => (typeof v === 'bigint' ? String(v) : v),
      2
    )
  );
  console.log(`\nbacked up all ${rows.length} rows to server/${backup}`);

  /* ----------------------------------------------------------- rewrite -- */

  const rewrites = [];
  let chainPrev = GENESIS_HASH;
  for (const r of rows) {
    const hash = hashRow(r, chainPrev);
    rewrites.push({ id: r.id, hash, prev: chainPrev });
    chainPrev = hash;
  }

  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('LOCK TABLE "AuditLog" IN EXCLUSIVE MODE');
      const live = await tx.auditLog.count();
      if (live !== rows.length) {
        throw new Error(`the table changed between reading and locking it (${rows.length} -> ${live}). Re-run.`);
      }

      for (const r of rewrites) {
        if (!/^[A-Za-z0-9_-]+$/.test(r.id)) throw new Error(`unexpected id: ${r.id}`);
        if (!/^[0-9a-f]{64}$/.test(r.hash) || !/^[0-9a-f]{64}$/.test(r.prev)) {
          throw new Error(`unexpected hash on ${r.id}`);
        }
      }
      // One statement rather than a round trip per row: the first attempt at
      // the Phase 4 re-seal spent longer than the transaction timeout holding
      // the lock and rolled the whole thing back.
      const values = rewrites.map((r) => `('${r.id}', '${r.hash}', '${r.prev}')`).join(',');
      await tx.$executeRawUnsafe(
        `UPDATE "AuditLog" AS a SET "hash" = v.hash, "prevHash" = v.prev
           FROM (VALUES ${values}) AS v(id, hash, prev)
          WHERE a."id" = v.id`
      );

      // The act, on the record it just rewrote.
      const createdAt = new Date();
      const seq = BigInt(rows[rows.length - 1].seq) + 1n;
      const prev = rewrites[rewrites.length - 1].hash;
      const row = {
        action: 'audit.reseal',
        entity: 'AuditLog',
        entityId: null,
        entityLabel: `re-sealed ${rows.length} rows; ${badHash.length} were unverifiable`,
        oldValues: null,
        newValues: {
          reason:
            'redact normalised Decimals only at the top level, so a Decimal inside an ' +
            'included relation hashed as {d,e,s} and stored as a number',
          unverifiableSeqs: badHash,
          resealedRows: rows.length,
          deletedRows: 0,
          backupFile: backup,
        },
        userId: null,
        ip: null,
        requestId: null,
        createdAt,
      };
      // `seq` has to be on the object handed to hashRow, not only spread into
      // `data`. The first run of this hashed seq as "undefined" and wrote a
      // row that failed the very check it had just repaired - caught only by
      // verifying afterwards, which is the entire argument for doing so.
      const sealed = { ...row, seq };
      await tx.auditLog.create({
        data: {
          ...sealed,
          prevHash: prev,
          hash: hashRow(sealed, prev),
          userName: 'reseal-audit-rows.mjs',
          method: 'script',
          path: 'scripts/reseal-audit-rows.mjs',
        },
      });
    },
    { timeout: 120_000, maxWait: 30_000 }
  );

  console.log('done. Run scripts/verify-audit-chain.mjs to confirm.');
} catch (err) {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : err}\nNothing was changed.`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
