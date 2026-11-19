import { prisma } from '../lib/prisma.js';
import { getSupabase, storageBucket } from '../lib/supabase.js';
import { objectNameFromStored } from '../lib/fileAccessToken.js';
import { logger } from '../lib/logger.js';

/**
 * Stop the storage bucket being a permanent archive of things that did not
 * need keeping (Phase 5).
 *
 * ---------------------------------------------------------------------------
 * What was actually in there, measured 19 Nov 2026
 *
 *   959 objects, 1,138 MB on a 1 GB plan
 *     324 objects   999 MB   referenced only by WhatsAppLog.mediaUrl
 *     547 objects   109 MB   referenced by nothing at all
 *      ~90 objects   ~30 MB   genuinely uploaded files
 *
 * Every media-bearing WhatsApp log is OUTBOUND, and the templates say what
 * they are: VERIFICATION_STATEMENT, DISPATCH_PARTY, PARTY_LEDGER,
 * BROKER_LEDGER, WISHES. Every one is a document this ERP generated from its
 * own data and sent out, and can regenerate on demand.
 *
 * They are in the bucket by accident of the send path, not by design: Fast2SMS
 * needs a URL it can fetch, so the PDF is uploaded to get one - and then never
 * removed. The bucket only ever needed to be a drop-box for a few seconds.
 *
 * Note what is NOT here: there are **no supplier invoices**.
 * `StockIn.invoiceFileUrl` matches nothing in storage, so none of this touches
 * a statutory record.
 * ---------------------------------------------------------------------------
 */

/**
 * How long a sent document stays fetchable.
 *
 * Matched to SHARED_FILE_TTL_SECONDS in lib/fileAccessToken.ts, which is the
 * life of a link handed to WhatsApp. If this were shorter, a link inside its
 * validity would 404 instead of expiring, and "it says the link is invalid"
 * is a worse answer than "it says the link expired". Keep the two in step.
 */
export const MEDIA_RETENTION_DAYS = Number(process.env.MEDIA_RETENTION_DAYS ?? 7);

/**
 * How long an unreferenced object is left alone before it counts as an orphan.
 *
 * This one matters more than it looks. A file is uploaded to storage *before*
 * the row that points at it is written, so every upload is briefly referenced
 * by nothing. Without this window, a cleanup running at the wrong moment would
 * delete a kata slip a second after it arrived, and the row would be left
 * pointing at nothing.
 */
export const ORPHAN_GRACE_HOURS = Number(process.env.ORPHAN_GRACE_HOURS ?? 48);

export interface StoredObject {
  name: string;
  size: number;
  createdAt: Date;
}

export interface RetentionPlan {
  total: { count: number; bytes: number };
  /** Referenced by something other than a sent-media log. Never deleted. */
  protectedByRow: { count: number; bytes: number };
  /** Sent documents still inside their retention window. */
  recentMedia: { count: number; bytes: number };
  /** Unreferenced, but too new to be sure. */
  tooNewToJudge: { count: number; bytes: number };
  deleteExpiredMedia: StoredObject[];
  deleteOrphans: StoredObject[];
}

export function bytesOf(objects: StoredObject[]): number {
  return objects.reduce((a, o) => a + o.size, 0);
}

/**
 * Decide what may go, given the bucket's contents and what the database
 * points at.
 *
 * Pure, so the classification can be tested without a bucket or a database -
 * which matters for a function whose mistakes are unrecoverable.
 */
export function classifyObjects(params: {
  objects: StoredObject[];
  /** Names referenced by any column other than WhatsAppLog.mediaUrl. */
  protectedNames: ReadonlySet<string>;
  /** Name -> the most recent send that used it. */
  sentMedia: ReadonlyMap<string, Date>;
  now: Date;
  retentionDays?: number;
  orphanGraceHours?: number;
}): RetentionPlan {
  const {
    objects,
    protectedNames,
    sentMedia,
    now,
    retentionDays = MEDIA_RETENTION_DAYS,
    orphanGraceHours = ORPHAN_GRACE_HOURS,
  } = params;

  const mediaCutoff = now.getTime() - retentionDays * 24 * 3600 * 1000;
  const orphanCutoff = now.getTime() - orphanGraceHours * 3600 * 1000;

  const keptProtected: StoredObject[] = [];
  const recentMedia: StoredObject[] = [];
  const tooNew: StoredObject[] = [];
  const deleteExpiredMedia: StoredObject[] = [];
  const deleteOrphans: StoredObject[] = [];

  for (const o of objects) {
    // A row that is not a send log points at it: keep, whatever its age.
    if (protectedNames.has(o.name)) {
      keptProtected.push(o);
      continue;
    }

    const lastSent = sentMedia.get(o.name);
    if (lastSent) {
      if (lastSent.getTime() < mediaCutoff) deleteExpiredMedia.push(o);
      else recentMedia.push(o);
      continue;
    }

    // Referenced by nothing. Only an orphan once it is old enough that it
    // cannot be an upload whose row has not landed yet.
    if (o.createdAt.getTime() < orphanCutoff) deleteOrphans.push(o);
    else tooNew.push(o);
  }

  return {
    total: { count: objects.length, bytes: bytesOf(objects) },
    protectedByRow: { count: keptProtected.length, bytes: bytesOf(keptProtected) },
    recentMedia: { count: recentMedia.length, bytes: bytesOf(recentMedia) },
    tooNewToJudge: { count: tooNew.length, bytes: bytesOf(tooNew) },
    deleteExpiredMedia,
    deleteOrphans,
  };
}

/** Every column that holds a stored file, except the send log. */
const PROTECTED_COLUMNS: { delegate: string; column: string; nullable: boolean }[] = [
  { delegate: 'stockIn', column: 'invoiceFileUrl', nullable: false },
  { delegate: 'saleOrder', column: 'invoiceFileUrl', nullable: true },
  { delegate: 'saleOrder', column: 'kataFileUrl', nullable: true },
  { delegate: 'saleOrder', column: 'buyerKataFileUrl', nullable: true },
  { delegate: 'saleDispatch', column: 'kataFileUrl', nullable: true },
  { delegate: 'saleDispatch', column: 'buyerKataFileUrl', nullable: true },
  { delegate: 'payment', column: 'screenshotUrl', nullable: true },
  { delegate: 'supportTicket', column: 'screenshotUrl', nullable: true },
  { delegate: 'wishBroadcast', column: 'imageUrl', nullable: true },
  { delegate: 'driverKataSubmission', column: 'imageUrl', nullable: false },
  { delegate: 'weighbridgeTicket', column: 'slipImageUrl', nullable: true },
];

/**
 * Names referenced by any column that is not the send log.
 *
 * Throws rather than returning a short set if any column cannot be read. A
 * half-built protected set would mean deleting files that something still
 * points at, and a silent catch here is the difference between a cleanup and
 * an incident.
 */
export async function collectProtectedNames(): Promise<Set<string>> {
  const names = new Set<string>();
  for (const { delegate, column, nullable } of PROTECTED_COLUMNS) {
    const d = (prisma as unknown as Record<string, any>)[delegate];
    if (!d) throw new Error(`no Prisma delegate "${delegate}" - the schema changed`);
    const where = nullable ? { [column]: { not: null } } : { NOT: { [column]: '' } };
    const rows = await d.findMany({ where, select: { [column]: true } });
    for (const row of rows) {
      const name = objectNameFromStored(row[column]);
      if (name) names.add(name);
    }
  }
  return names;
}

/** Name -> most recent send that used it. */
export async function collectSentMedia(): Promise<Map<string, Date>> {
  const rows = await prisma.whatsAppLog.findMany({
    where: { mediaUrl: { not: null } },
    select: { mediaUrl: true, createdAt: true },
  });
  const map = new Map<string, Date>();
  for (const r of rows) {
    const name = objectNameFromStored(r.mediaUrl);
    if (!name) continue;
    const seen = map.get(name);
    if (!seen || r.createdAt > seen) map.set(name, r.createdAt);
  }
  return map;
}

/** Everything in the bucket, paged. */
export async function listBucket(): Promise<StoredObject[]> {
  const supabase = getSupabase();
  const bucket = storageBucket();
  const out: StoredObject[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.storage.from(bucket).list('', { limit: 1000, offset });
    if (error) throw new Error(`could not list ${bucket}: ${error.message}`);
    if (!data?.length) break;
    for (const o of data) {
      out.push({
        name: o.name,
        size: (o as { metadata?: { size?: number } }).metadata?.size ?? 0,
        createdAt: new Date(o.created_at ?? Date.now()),
      });
    }
    if (data.length < 1000) break;
  }
  return out;
}

export async function planRetention(now: Date = new Date()): Promise<RetentionPlan> {
  const [objects, protectedNames, sentMedia] = await Promise.all([
    listBucket(),
    collectProtectedNames(),
    collectSentMedia(),
  ]);

  // If nothing at all is protected, something is wrong with the queries rather
  // than with the data - refuse rather than propose deleting the lot.
  if (objects.length > 0 && protectedNames.size === 0 && sentMedia.size === 0) {
    throw new Error(
      'no stored file is referenced by any row, which cannot be right. Refusing to plan a deletion.'
    );
  }

  return classifyObjects({ objects, protectedNames, sentMedia, now });
}

/** Delete the objects a plan named. Returns how many went, and how much. */
export async function applyRetention(plan: RetentionPlan): Promise<{
  deleted: number;
  bytes: number;
  failed: string[];
}> {
  const victims = [...plan.deleteExpiredMedia, ...plan.deleteOrphans];
  if (victims.length === 0) return { deleted: 0, bytes: 0, failed: [] };

  const supabase = getSupabase();
  const bucket = storageBucket();
  const failed: string[] = [];
  let deleted = 0;
  let bytes = 0;

  // Supabase takes an array; batched so one huge request cannot time out and
  // leave the caller unsure what went.
  for (let i = 0; i < victims.length; i += 100) {
    const batch = victims.slice(i, i + 100);
    const { error } = await supabase.storage.from(bucket).remove(batch.map((o) => o.name));
    if (error) {
      failed.push(...batch.map((o) => o.name));
      logger.warn(`[file-retention] a batch of ${batch.length} failed: ${error.message}`);
      continue;
    }
    deleted += batch.length;
    bytes += bytesOf(batch);
  }

  logger.info(
    `[file-retention] removed ${deleted} object(s), ${(bytes / 1048576).toFixed(1)} MB` +
      (failed.length ? `; ${failed.length} failed` : '')
  );
  return { deleted, bytes, failed };
}
