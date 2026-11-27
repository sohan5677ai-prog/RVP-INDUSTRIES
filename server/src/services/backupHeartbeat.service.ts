import { Prisma, type PrismaClient } from '@prisma/client';
import { GENESIS_HASH, hashRow } from '../lib/auditChain.js';

/**
 * Record that a backup was taken, where the server can see it (Phase 8/9).
 *
 * The backup runs on an office PC and writes to a OneDrive folder. The monitor
 * that is supposed to notice "no backup for two days" runs on Render, which
 * cannot see that folder - so without a trace in the database, the one alert
 * written for the failure that actually happened could never observe it.
 *
 * It writes an `backup.taken` row straight into the audit trail rather than a
 * table of its own: the trail already answers "what happened and when", a
 * backup is exactly that, and a second near-identical table would be one more
 * thing to remember to look at.
 *
 * Written with the chain maintained by hand because this runs from a script
 * against its own Prisma client, outside the server process and its audit
 * extension. It appends under the same rules as `recordAudit` - lock the tail,
 * take the next seq, hash over the previous row - so the chain still verifies
 * afterwards.
 */
export async function recordBackupTaken(
  prisma: PrismaClient,
  detail: Record<string, unknown>
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const tail = await tx.$queryRaw<{ seq: bigint; hash: string }[]>`
      SELECT "seq", "hash" FROM "AuditLog" ORDER BY "seq" DESC LIMIT 1 FOR UPDATE
    `;
    const prevHash = tail[0]?.hash ?? GENESIS_HASH;
    const seq = (tail[0]?.seq ?? 0n) + 1n;
    const createdAt = new Date();

    const row = {
      seq,
      action: 'backup.taken',
      entity: 'Backup',
      entityId: null,
      oldValues: null,
      newValues: detail,
      userId: null,
      ip: null,
      requestId: null,
      createdAt,
    };

    await tx.auditLog.create({
      data: {
        ...row,
        // Hashed as plain null above, stored as the Prisma sentinel here -
        // the one place those two must be kept apart. See audit.service.ts.
        oldValues: Prisma.JsonNull,
        newValues: detail as Prisma.InputJsonValue,
        prevHash,
        hash: hashRow(row, prevHash),
        entityLabel: String(detail.file ?? 'backup'),
        userName: 'backup-database.mjs',
        method: 'script',
        path: 'scripts/backup-database.mjs',
      },
    });
  });
}
