import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { ACTIVE_DISPATCH_DAYS, normaliseVehicleNumber } from '../controllers/gps.controller.js';

/**
 * Pruning the GPS trail.
 *
 * VehiclePing is the only table in the ERP that grows on a timer rather than
 * on someone doing business: the poller writes a row per vehicle per fix, for
 * the transporter's whole fleet and not just our lorries, which is tens of
 * thousands of rows a day and nothing in the application ever deleting one.
 * Left alone it fills the free 500 MB database in about six weeks and takes
 * the rest of the ERP down with it, so retention is not housekeeping here -
 * it is what keeps the feature affordable.
 *
 * Two windows, because the two kinds of row are worth keeping for different
 * lengths of time:
 *
 * - A plate on one of our open dispatches keeps its trail for the long window:
 *   a delivery dispute is argued weeks later and the trail is the only record,
 *   since the provider has no history endpoint.
 * - Every other plate - someone else's lorry that happened to be on the feed -
 *   keeps the short window. Those rows exist so the office can see which
 *   vehicle is free today; last month's answer is of no use to anyone.
 *
 * The long window also acts as the backstop for a dispatch nobody ever closed,
 * which would otherwise hold its plate's trail open forever.
 */

/** Short window: plates with nothing of ours on them. */
const DEFAULT_RETENTION_DAYS = 30;
/** Long window: applies to everything, our own open dispatches included. */
const DEFAULT_HARD_RETENTION_DAYS = 90;

/**
 * Rows per `deleteMany`. A single unbounded delete over a month of backlog is
 * one long transaction on the smallest Postgres instance Supabase sells; a few
 * thousand at a time keeps each statement short and lets the job give up
 * part-done without having held a lock the whole while.
 */
const BATCH = 5_000;

export interface GpsPruneResult {
  /** Rows removed by the short window. */
  prunedIdle: number;
  /** Rows removed by the long window. */
  prunedOld: number;
  /** Plates protected by an open dispatch. */
  protectedPlates: number;
  tookMs: number;
}

function envDays(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Delete in batches until the predicate stops matching.
 *
 * `deleteMany` takes no limit, so the batch is established by selecting ids
 * first. That is a second query per round, which is the price of never issuing
 * a delete whose size we do not already know.
 */
async function deleteInBatches(where: object): Promise<number> {
  let total = 0;
  for (;;) {
    const batch = await prisma.vehiclePing.findMany({
      where,
      select: { id: true },
      take: BATCH,
    });
    if (batch.length === 0) break;
    const { count } = await prisma.vehiclePing.deleteMany({
      where: { id: { in: batch.map((r) => r.id) } },
    });
    total += count;
    if (batch.length < BATCH) break;
  }
  return total;
}

/**
 * One retention pass. Never throws: this runs from a timer and from boot, and
 * a failed prune must not be able to stop the server coming up.
 */
export async function pruneVehiclePings(): Promise<GpsPruneResult> {
  const started = Date.now();
  const retentionDays = envDays('GPS_PING_RETENTION_DAYS', DEFAULT_RETENTION_DAYS);
  const hardDays = Math.max(
    retentionDays,
    envDays('GPS_PING_HARD_RETENTION_DAYS', DEFAULT_HARD_RETENTION_DAYS)
  );

  const result: GpsPruneResult = { prunedIdle: 0, prunedOld: 0, protectedPlates: 0, tookMs: 0 };

  try {
    // The same definition of "ours" the poller uses for resolution, so a plate
    // cannot be worth full-resolution rows to one and prunable to the other.
    const dispatches = await prisma.saleDispatch.findMany({
      where: {
        status: 'DISPATCHED',
        vehicleNumber: { not: null },
        dispatchDate: { gte: new Date(Date.now() - ACTIVE_DISPATCH_DAYS * 24 * 3_600_000) },
      },
      select: { vehicleNumber: true },
    });
    const plates = [
      ...new Set(
        dispatches.map((d) => normaliseVehicleNumber(d.vehicleNumber ?? '')).filter(Boolean)
      ),
    ];
    result.protectedPlates = plates.length;

    const idleCutoff = new Date(Date.now() - retentionDays * 24 * 3_600_000);
    result.prunedIdle = await deleteInBatches({
      recordedAt: { lt: idleCutoff },
      ...(plates.length > 0 ? { vehicleNumber: { notIn: plates } } : {}),
    });

    const hardCutoff = new Date(Date.now() - hardDays * 24 * 3_600_000);
    result.prunedOld = await deleteInBatches({ recordedAt: { lt: hardCutoff } });

    const total = result.prunedIdle + result.prunedOld;
    if (total > 0) {
      logger.info(
        `[gps-retention] pruned ${total} ping(s) - ${result.prunedIdle} past ${retentionDays}d off-dispatch, ` +
          `${result.prunedOld} past ${hardDays}d, ${plates.length} plate(s) held`
      );
    }
  } catch (err) {
    logger.error('[gps-retention] prune failed:', err);
  }

  result.tookMs = Date.now() - started;
  return result;
}
