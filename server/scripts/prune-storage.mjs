/**
 * Remove stored files that nothing needs any more (Phase 5).
 *
 *   node scripts/prune-storage.mjs                      # dry run
 *   node scripts/prune-storage.mjs --orphans-only       # dry run, orphans only
 *   node scripts/prune-storage.mjs --apply --confirm=<bucket>
 *
 * ---------------------------------------------------------------------------
 * Measured 19 Nov 2026: 959 objects, 1,138 MB on a 1 GB plan.
 *
 *   324 objects   999 MB   referenced only by WhatsAppLog.mediaUrl
 *   547 objects   109 MB   referenced by nothing at all
 *    ~90 objects    30 MB   genuinely uploaded files
 *
 * The 999 MB are documents this ERP generated and sent over WhatsApp -
 * statements, dispatch notes, ledgers - kept for ever by accident of the send
 * path rather than by design. They regenerate on demand. There are **no
 * supplier invoices in storage**: StockIn.invoiceFileUrl matches nothing, so
 * nothing here touches a statutory record.
 * ---------------------------------------------------------------------------
 *
 * Two kinds of deletion, deliberately separated because they are different
 * decisions:
 *
 *   orphans       nothing references them. Safe without any policy, and
 *                 --orphans-only does just these.
 *   expired media sent documents past MEDIA_RETENTION_DAYS. A policy choice.
 *
 * Guards, in the same spirit as scripts/mask-database.mjs: dry run by default,
 * --apply plus --confirm=<bucket name> to proceed, and a refusal if nothing in
 * the bucket turns out to be referenced - that would mean the queries are
 * broken, not that the files are unused.
 */
import 'dotenv/config';
import {
  planRetention,
  applyRetention,
  MEDIA_RETENTION_DAYS,
  ORPHAN_GRACE_HOURS,
  bytesOf,
} from '../dist/services/fileRetention.service.js';
import { storageBucket } from '../dist/lib/supabase.js';

const APPLY = process.argv.includes('--apply');
const ORPHANS_ONLY = process.argv.includes('--orphans-only');
const CONFIRM = (process.argv.find((a) => a.startsWith('--confirm=')) ?? '').split('=')[1] ?? '';

const mb = (n) => (n / 1048576).toFixed(1);
const bucket = storageBucket();

if (APPLY && CONFIRM !== bucket) {
  console.error(
    `\nREFUSED: --apply needs --confirm=<bucket>.\n` +
      `  bucket     : ${bucket}\n` +
      `  you passed : ${CONFIRM || '(nothing)'}\n` +
      'Read the bucket name above and retype it.\nNothing was changed.'
  );
  process.exit(1);
}

try {
  const plan = await planRetention();

  console.log(`${APPLY ? 'APPLYING to' : 'DRY RUN against'} bucket "${bucket}"\n`);
  console.log(`  total                 ${String(plan.total.count).padStart(5)}  ${mb(plan.total.bytes).padStart(8)} MB`);
  console.log('  ------------------------------------------- keeping');
  console.log(`  referenced by a row   ${String(plan.protectedByRow.count).padStart(5)}  ${mb(plan.protectedByRow.bytes).padStart(8)} MB`);
  console.log(`  sent < ${String(MEDIA_RETENTION_DAYS).padStart(2)}d ago       ${String(plan.recentMedia.count).padStart(5)}  ${mb(plan.recentMedia.bytes).padStart(8)} MB`);
  console.log(`  newer than ${String(ORPHAN_GRACE_HOURS).padStart(2)}h        ${String(plan.tooNewToJudge.count).padStart(5)}  ${mb(plan.tooNewToJudge.bytes).padStart(8)} MB  (an upload's row may not have landed yet)`);
  console.log('  ------------------------------------------- deleting');
  console.log(`  orphaned              ${String(plan.deleteOrphans.length).padStart(5)}  ${mb(bytesOf(plan.deleteOrphans)).padStart(8)} MB`);
  if (!ORPHANS_ONLY) {
    console.log(`  sent > ${String(MEDIA_RETENTION_DAYS).padStart(2)}d ago       ${String(plan.deleteExpiredMedia.length).padStart(5)}  ${mb(bytesOf(plan.deleteExpiredMedia)).padStart(8)} MB`);
  } else {
    console.log(`  sent > ${String(MEDIA_RETENTION_DAYS).padStart(2)}d ago           -         -       (skipped: --orphans-only)`);
  }

  const effective = ORPHANS_ONLY ? { ...plan, deleteExpiredMedia: [] } : plan;
  const freeing = bytesOf([...effective.deleteExpiredMedia, ...effective.deleteOrphans]);
  console.log(
    `\n  would free ${mb(freeing)} MB, leaving ${mb(plan.total.bytes - freeing)} MB`
  );

  if (!APPLY) {
    console.log(`\nRe-run with --apply --confirm=${bucket} to do it.`);
    process.exit(0);
  }

  const result = await applyRetention(effective);
  console.log(`\ndeleted ${result.deleted} object(s), freed ${mb(result.bytes)} MB`);
  if (result.failed.length) {
    console.log(`${result.failed.length} could not be removed; re-run to retry them.`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : err}\nNothing was changed.`);
  process.exitCode = 1;
}
