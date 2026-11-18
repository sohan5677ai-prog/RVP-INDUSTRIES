/**
 * Prune the audit rows written by the broken writer, and re-seal the chain.
 *
 *   node scripts/reseal-audit-chain.mjs            # dry run, changes nothing
 *   node scripts/reseal-audit-chain.mjs --apply    # does it
 *
 * ---------------------------------------------------------------------------
 * ALREADY RUN - 18 Nov 2026, 21:39 IST. 36 rows pruned, 121 re-sealed, the act
 * recorded as the `audit.prune` row at seq 122, backup in server/backups/.
 * Kept in the tree as the record of what was done and how. Re-running it now
 * aborts on the first safety check, because the rows it names are gone.
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, AND WHY IT IS DANGEROUS
 *
 * Until 18 Nov 2026 `recordAudit` hashed the values Prisma handed it and
 * stored a different, redacted copy, so every row carrying money, a weight or
 * a credential field was unverifiable from the moment it was written. 38 rows
 * are in that state. See docs/security/PHASE-4.md.
 *
 * Recomputing hashes over an audit table is EXACTLY what someone covering
 * their tracks would do. That is why this is a script you have to run
 * deliberately, with --apply, rather than a migration; why it refuses to touch
 * anything written after the fix landed; why it writes a full backup first;
 * and why it appends an `audit.prune` row recording what it did, so the act is
 * itself on the record it just rewrote.
 *
 * Removing rows from the middle of a hash chain breaks every link after them,
 * so pruning cannot be done without re-sealing the rest. `seq` is also
 * compacted back to 1..N, because a permanent gap would make the verifier
 * report a break for ever - and a verifier that is always red is one nobody
 * reads. The cost is real and worth stating: after this runs, the gapless-seq
 * property no longer evidences these deletions. The `audit.prune` row and the
 * backup file are what stand in for it.
 * ---------------------------------------------------------------------------
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

const GENESIS_HASH = '0'.repeat(64);
const APPLY = process.argv.includes('--apply');

/**
 * The rows to remove, named explicitly rather than matched by a predicate.
 *
 * A predicate would silently widen if it were ever run again, or against a
 * different database. This list is reviewable, and the script verifies each
 * one still looks like what was reviewed before it deletes anything.
 */
const PRUNE = [
  1, 2, 3, 4, 5, 6,
  9, 10, 11, 12, 13, 14,
  17, 18, 19, 20, 21, 22,
  25, 26, 27, 28, 29, 30,
  33, 34, 35, 36, 37, 38,
  44, 45, 46, 47, 48, 49,
];

/** The only actions those rows may have. Anything else aborts. */
const EXPECTED_ACTIONS = new Set([
  'account.update',
  'subscriptionPlanConfig.update',
  'transport.update',
]);

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

function hashRow(row, seq, prevHash) {
  const payload = canonicalise({
    seq: String(seq),
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
const fail = (msg) => {
  console.error(`\nABORTED: ${msg}\nNothing was changed.`);
  process.exitCode = 1;
};

try {
  const all = await prisma.auditLog.findMany({ orderBy: { seq: 'asc' } });
  if (all.length === 0) {
    console.log('AuditLog is empty; nothing to do.');
    process.exit(0);
  }

  const pruneSet = new Set(PRUNE.map(BigInt));
  const toPrune = all.filter((r) => pruneSet.has(BigInt(r.seq)));
  const toKeep = all.filter((r) => !pruneSet.has(BigInt(r.seq)));

  /* ---------------------------------------------------- safety checks ---- */

  if (toPrune.length !== PRUNE.length) {
    fail(
      `expected to find all ${PRUNE.length} rows named in PRUNE, found ${toPrune.length}. ` +
        `The table is not in the state this script was reviewed against.`
    );
    process.exit(1);
  }

  const wrongAction = toPrune.filter((r) => !EXPECTED_ACTIONS.has(r.action));
  if (wrongAction.length > 0) {
    fail(
      `these rows are not the restart noise this script is for: ` +
        wrongAction.map((r) => `seq ${r.seq} (${r.action})`).join(', ')
    );
    process.exit(1);
  }

  const byAPerson = toPrune.filter((r) => r.userId !== null);
  if (byAPerson.length > 0) {
    fail(
      `refusing to delete rows attributed to a user: ` +
        byAPerson.map((r) => `seq ${r.seq} (${r.userName ?? r.userId})`).join(', ')
    );
    process.exit(1);
  }

  // The whole justification is that these predate the fix. Anything written
  // after it verifies already and must not be touched.
  const alreadyGood = toPrune.filter((r) => hashRow(r, BigInt(r.seq), r.prevHash) === r.hash);
  if (alreadyGood.length > 0) {
    fail(
      `refusing to delete rows whose seal is already valid: ` +
        alreadyGood.map((r) => `seq ${r.seq}`).join(', ')
    );
    process.exit(1);
  }

  /* ------------------------------------------------------- the report ---- */

  const stillBroken = toKeep.filter((r) => hashRow(r, BigInt(r.seq), r.prevHash) !== r.hash);

  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN - nothing will change'}\n`);
  console.log(`rows now            : ${all.length}`);
  console.log(`  to delete         : ${toPrune.length}  (seq ${PRUNE[0]}..${PRUNE[PRUNE.length - 1]}, restart noise, all written by "system")`);
  console.log(`  to keep           : ${toKeep.length}`);
  console.log(`  of those, re-sealed because their seal is wrong : ${stillBroken.length}`);
  for (const r of stillBroken) {
    console.log(`      seq ${String(r.seq).padStart(4)}  ${r.action}  ${r.entityId ?? ''}`);
  }
  console.log(`  of those, re-linked only (content unchanged)    : ${toKeep.length - stillBroken.length}`);
  console.log(`\nafter: seq 1..${toKeep.length + 1} with no gaps, including one audit.prune row recording this.`);

  const counts = {};
  for (const r of toPrune) counts[r.action] = (counts[r.action] ?? 0) + 1;
  console.log('\ndeleting:');
  for (const [a, n] of Object.entries(counts)) console.log(`  ${String(n).padStart(3)}  ${a}`);

  if (!APPLY) {
    console.log('\nRe-run with --apply to do it.');
    process.exit(0);
  }

  /* ---------------------------------------------------------- backup ---- */

  mkdirSync('backups', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `backups/auditlog-before-reseal-${stamp}.json`;
  writeFileSync(
    backup,
    JSON.stringify(
      { takenAt: new Date().toISOString(), reason: 'prune + re-seal after the Decimal/redaction hashing bug', rows: all },
      (_k, v) => (typeof v === 'bigint' ? String(v) : v),
      2
    )
  );
  console.log(`\nbacked up all ${all.length} rows to server/${backup}`);

  /* ------------------------------------------------------- the rewrite -- */

  // Computed outside the transaction: hashing 121 rows is pure CPU work and
  // has no business holding a lock on a table two servers are writing to.
  const rewrites = [];
  {
    let prevHash = GENESIS_HASH;
    let seq = 1n;
    for (const row of toKeep) {
      const hash = hashRow(row, seq, prevHash);
      rewrites.push({ id: row.id, seq, hash, prevHash });
      prevHash = hash;
      seq += 1n;
    }
  }
  const finalPrevHash = rewrites.length ? rewrites[rewrites.length - 1].hash : GENESIS_HASH;
  const finalSeq = BigInt(rewrites.length + 1);

  await prisma.$transaction(
    async (tx) => {
      // Both the local and the deployed server write to this table. Without an
      // exclusive lock a row arriving mid-rewrite would be sealed against a
      // tail that is about to move.
      await tx.$executeRawUnsafe('LOCK TABLE "AuditLog" IN EXCLUSIVE MODE');

      const live = await tx.auditLog.count();
      if (live !== all.length) {
        throw new Error(
          `the table changed between reading and locking it (${all.length} -> ${live}). Re-run.`
        );
      }

      await tx.auditLog.deleteMany({ where: { seq: { in: [...pruneSet] } } });

      // Renumbering in two passes, via negative numbers. `seq` is uniquely
      // indexed and the index is not deferrable, so a single bulk UPDATE would
      // hit a transient duplicate: the row moving into slot 7 collides with
      // the row still sitting in slot 7 until it moves. Negative slots are
      // guaranteed free, so neither pass can collide.
      //
      // Two statements rather than 121 round trips, because the first attempt
      // at this spent longer than Prisma's interactive-transaction timeout
      // holding the lock and rolled the whole thing back.
      // These values are interpolated into SQL, so they are checked rather
      // than trusted: ids come from the database and hashes from this script,
      // but a literal built by string concatenation gets verified on principle.
      for (const r of rewrites) {
        if (!/^[A-Za-z0-9_-]+$/.test(r.id)) throw new Error(`unexpected id: ${r.id}`);
        if (!/^[0-9a-f]{64}$/.test(r.hash) || !/^[0-9a-f]{64}$/.test(r.prevHash)) {
          throw new Error(`unexpected hash on id ${r.id}`);
        }
      }

      const values = rewrites
        .map((r) => `('${r.id}', ${r.seq}::bigint, '${r.hash}', '${r.prevHash}')`)
        .join(',');

      await tx.$executeRawUnsafe(
        `UPDATE "AuditLog" AS a SET "seq" = -v.seq
           FROM (VALUES ${values}) AS v(id, seq, hash, prev)
          WHERE a."id" = v.id`
      );
      await tx.$executeRawUnsafe(
        `UPDATE "AuditLog" AS a SET "seq" = v.seq, "hash" = v.hash, "prevHash" = v.prev
           FROM (VALUES ${values}) AS v(id, seq, hash, prev)
          WHERE a."id" = v.id`
      );

      // The act, on the record it just rewrote.
      const createdAt = new Date();
      const pruneRow = {
        action: 'audit.prune',
        entity: 'AuditLog',
        entityId: null,
        entityLabel: `pruned ${toPrune.length}, re-sealed ${toKeep.length}`,
        oldValues: null,
        newValues: {
          reason:
            'rows written before the Decimal/redaction hashing fix could never verify; ' +
            'restart-noise rows deleted, the rest re-sealed',
          deletedSeqs: PRUNE,
          deletedActions: counts,
          keptAndResealed: toKeep.length,
          backupFile: backup,
          fixCommit: '86e2c3c',
        },
        userId: null,
        ip: null,
        requestId: null,
        createdAt,
      };
      await tx.auditLog.create({
        data: {
          ...pruneRow,
          seq: finalSeq,
          prevHash: finalPrevHash,
          hash: hashRow(pruneRow, finalSeq, finalPrevHash),
          userName: 'reseal-audit-chain.mjs',
          method: 'script',
          path: 'scripts/reseal-audit-chain.mjs',
        },
      });
    },
    // Generous, because the cost of this timing out half way is a rollback of
    // the whole rewrite - which is correct, but means doing it all again.
    { timeout: 120_000, maxWait: 30_000 }
  );

  console.log('done. Run scripts/verify-audit-chain.mjs to confirm.');
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  await prisma.$disconnect();
}
