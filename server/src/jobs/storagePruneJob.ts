import cron from 'node-cron';
import { logger } from '../lib/logger.js';
import {
  planRetention,
  applyRetention,
  bytesOf,
  MEDIA_RETENTION_DAYS,
  ORPHAN_GRACE_HOURS,
} from '../services/fileRetention.service.js';
import { recordAudit } from '../services/audit.service.js';

/**
 * Nightly sweep that keeps the storage bucket from becoming an archive again
 * (Phase 5).
 *
 * The bucket reached 1,138 MB on a 1 GB plan because sent WhatsApp documents
 * were uploaded to give Fast2SMS a URL to fetch and then never removed. A
 * one-off prune took it to 81 MB; this is what stops it climbing back.
 *
 * ---------------------------------------------------------------------------
 * Three decisions worth stating, because this deletes files unattended
 *
 * **No boot catch-up.** The subscription job catches up on boot because a
 * missed charge matters. Render restarts on every deploy, so a prune that ran
 * on boot would delete files several times a day and make "when did that file
 * go?" unanswerable. Nothing here is urgent: a file that should go tonight can
 * go tomorrow night instead.
 *
 * **Every run is audited**, even one that deletes nothing. An unattended job
 * that removes data should leave a record of having run, and `storage.prune`
 * in the audit trail is what turns "where did that go?" into an answer. The
 * rows are one a day, so this will not repeat the noise problem of PHASE-4.
 *
 * **It can be switched off** with STORAGE_PRUNE_ENABLED=false, and it says at
 * boot whether it is scheduled - a deleting job that is silently on, or
 * silently off, is bad in both directions.
 * ---------------------------------------------------------------------------
 *
 * The safety is in the classification rather than in this file: a file any row
 * points at is never touched, an unreferenced file is left alone for
 * ORPHAN_GRACE_HOURS in case its row has not landed yet, and the plan refuses
 * outright if nothing in the bucket turns out to be referenced. See
 * services/fileRetention.service.ts.
 */

const ENABLED = process.env.STORAGE_PRUNE_ENABLED !== 'false';

/** Exported so it can be driven directly, and tested without a timer. */
export async function runStoragePrune(): Promise<{ deleted: number; bytes: number }> {
  const plan = await planRetention();
  const candidates = [...plan.deleteExpiredMedia, ...plan.deleteOrphans];

  if (candidates.length === 0) {
    logger.info('[storage-prune] nothing to remove');
    await recordAudit({
      action: 'storage.prune',
      entity: 'Storage',
      entityLabel: 'nothing to remove',
      newValues: { deleted: 0, freedBytes: 0, keptObjects: plan.total.count },
    });
    return { deleted: 0, bytes: 0 };
  }

  logger.info(
    `[storage-prune] removing ${plan.deleteOrphans.length} orphan(s) and ` +
      `${plan.deleteExpiredMedia.length} sent document(s) older than ${MEDIA_RETENTION_DAYS}d ` +
      `(${(bytesOf(candidates) / 1048576).toFixed(1)} MB)`
  );

  const result = await applyRetention(plan);

  await recordAudit({
    action: 'storage.prune',
    entity: 'Storage',
    entityLabel: `removed ${result.deleted} object(s), ${(result.bytes / 1048576).toFixed(1)} MB`,
    newValues: {
      deleted: result.deleted,
      freedBytes: result.bytes,
      orphans: plan.deleteOrphans.length,
      expiredMedia: plan.deleteExpiredMedia.length,
      failed: result.failed.length,
      retentionDays: MEDIA_RETENTION_DAYS,
      orphanGraceHours: ORPHAN_GRACE_HOURS,
      remainingObjects: plan.total.count - result.deleted,
    },
  });

  return { deleted: result.deleted, bytes: result.bytes };
}

export function registerStoragePruneCron(): void {
  if (!ENABLED) {
    logger.info('[storage-prune] disabled (unset STORAGE_PRUNE_ENABLED=false to enable)');
    return;
  }

  // 03:40 IST: after the night's dispatches have settled and well clear of the
  // 00:15 subscription sweep, so a slow listing cannot delay the books.
  cron.schedule(
    '40 3 * * *',
    () => {
      runStoragePrune().catch((err) =>
        // Never throws onward: a failed cleanup is a cleanup that did not
        // happen, not an incident, and tomorrow night will try again.
        logger.error('[storage-prune] nightly sweep failed:', err)
      );
    },
    { timezone: 'Asia/Kolkata' }
  );

  logger.info(
    `[storage-prune] scheduled 03:40 IST; keeps sent documents ${MEDIA_RETENTION_DAYS}d, ` +
      `unreferenced files ${ORPHAN_GRACE_HOURS}h`
  );
}
