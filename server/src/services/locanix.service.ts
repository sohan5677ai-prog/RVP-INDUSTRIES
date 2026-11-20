import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import {
  parsePingRecord,
  normaliseVehicleNumber,
  ACTIVE_DISPATCH_DAYS,
  type ParsedPing,
} from '../controllers/gps.controller.js';

/**
 * Locanix GPS - the pull side.
 *
 * The provider ended up offering a pull API rather than the push webhook in
 * docs/locanix-gps-push-api.md: one unparameterised endpoint that returns the
 * last known position of every vehicle on the transporter's account. So this
 * service calls them on a timer and writes through the same parser and the
 * same idempotency key the webhook uses - the webhook stays mounted, because a
 * second vendor may well prefer to push, and both paths land in VehiclePing.
 *
 * Three facts about their feed shape everything here:
 *
 * 1. **One call returns the whole fleet** (145 vehicles at the time of
 *    writing), not just ours. There is no per-vehicle filter and no history
 *    endpoint, so the trail of a trip exists only because we poll and store.
 * 2. **The token may pull at most once every 30 seconds.** Past that they
 *    answer `{ ok: false, error: 'Rate limited...', retryAfterSeconds }` with
 *    no positions at all, so the poll interval has a hard floor.
 * 3. **Most of the fleet is not ours.** 93 of 145 were Offline and 21 had not
 *    reported in over a week. Storing every vehicle at full resolution would
 *    be ~200k rows a day for the sake of lorries we have no consignment on, so
 *    the resolution policy below keeps full detail for the lorries that are on
 *    one of our dispatches and thins the rest.
 */

const DEFAULT_BASE_URL = 'https://compass.apps2.uctechlabs.com/api/standard-api';

/** Their documented floor is 30s; 35s leaves room for a retry inside a tick. */
const MIN_POLL_SECONDS = 35;
/**
 * Two minutes, not one.
 *
 * Every tick that finds a new device timestamp on one of our lorries writes a
 * row, so the interval is the row-growth dial for the whole table: at 60s a
 * single lorry on dispatch is 1,440 rows a day, at 120s it is 720. A lorry
 * board does not need better than a two-minute fix, and the free Supabase
 * database is 500 MB shared with the rest of the ERP. Override with
 * LOCANIX_POLL_SECONDS where a particular trip needs finer resolution.
 */
const DEFAULT_POLL_SECONDS = 120;

/** How long a cached list of active-dispatch plates stays good. */
const ACTIVE_PLATES_TTL_MS = 60_000;

/**
 * Thinning for vehicles that are NOT on one of our dispatches: keep a fix only
 * if it is this much newer than the last one we stored, or the lorry has moved
 * this far, or the provider's status changed. Our own lorries bypass all three.
 */
const IDLE_MIN_GAP_MS = 5 * 60_000;
const IDLE_MIN_MOVE_M = 200;

export interface LocanixPollResult {
  ok: boolean;
  at: string;
  /** Vehicles in the provider's response. */
  fetched: number;
  /** Readings that parsed into a storable ping. */
  parsed: number;
  /** Readings kept after the resolution policy. */
  kept: number;
  /** Rows actually written (the rest were already held). */
  stored: number;
  /** Plates matched to a dispatch still in DISPATCHED. */
  onDispatch: number;
  rejected: { vehicle: string; reason: string }[];
  error?: string;
  /** Milliseconds the provider call took. */
  tookMs: number;
}

/* ------------------------------------------------------------------ config */

export function locanixConfig() {
  const apiKey = process.env.LOCANIX_API_KEY?.trim();
  const baseUrl = process.env.LOCANIX_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const seconds = Number(process.env.LOCANIX_POLL_SECONDS) || DEFAULT_POLL_SECONDS;
  return {
    apiKey,
    baseUrl,
    configured: Boolean(apiKey),
    // Enabled by default once a key exists: a GPS integration that needs a
    // second flag set to do anything is a GPS integration that is quietly off.
    enabled: process.env.LOCANIX_POLL_ENABLED !== 'false' && Boolean(apiKey),
    pollSeconds: Math.max(MIN_POLL_SECONDS, seconds),
  };
}

/* ------------------------------------------------------------ poller state */

interface LastStored {
  recordedAt: number;
  latitude: number;
  longitude: number;
  status?: string;
}

/**
 * Last row written per plate, for the thinning rule. In memory on purpose: it
 * is an optimisation, not a source of truth, and a restart costs one extra row
 * per vehicle. The unique key still stops any true duplicate.
 */
const lastStored = new Map<string, LastStored>();

let lastResult: LocanixPollResult | null = null;
let polling = false;
/** Set when the provider rate-limits us, so the next tick stands down. */
let notBefore = 0;

let activePlates: { at: number; plates: Set<string> } | null = null;

export function getLocanixStatus() {
  const cfg = locanixConfig();
  return {
    provider: 'LOCANIX',
    configured: cfg.configured,
    enabled: cfg.enabled,
    pollSeconds: cfg.pollSeconds,
    baseUrl: cfg.configured ? cfg.baseUrl : null,
    lastPoll: lastResult,
    trackedVehicles: lastStored.size,
  };
}

/* --------------------------------------------------------------- utilities */

/** Metres between two fixes. Equirectangular: at lorry distances it is exact enough. */
export function metresBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000;
  const toRad = Math.PI / 180;
  const x = (bLng - aLng) * toRad * Math.cos(((aLat + bLat) / 2) * toRad);
  const y = (bLat - aLat) * toRad;
  return Math.sqrt(x * x + y * y) * R;
}

/**
 * The plates worth storing at full resolution: our own trips, in both
 * directions.
 *
 * Three sets, all of them ours:
 *
 *  - a dispatch still in DISPATCHED - a loaded lorry on the road;
 *  - a lorry a transporter has booked against a live purchase order;
 *  - an empty lorry confirmed against an open loading slot, on its way here to
 *    collect a sale load.
 *
 * The last two are not a nicety. The thinning rule below keeps one fix per five
 * minutes for everything that is not on this list, and a lorry at 50 km/h
 * covers four km in five minutes. A lorry left to the thinned feed can
 * therefore go from eleven km to seven to one between two stored fixes, and the
 * approach rings that are supposed to fire at ten km and at the gate would both
 * be stepped straight over. The rings are only as good as this set.
 */
async function getActiveDispatchPlates(): Promise<Set<string>> {
  if (activePlates && Date.now() - activePlates.at < ACTIVE_PLATES_TTL_MS) return activePlates.plates;
  const [dispatches, arrivals, loadingSlots] = await Promise.all([
    prisma.saleDispatch.findMany({
      where: {
        status: 'DISPATCHED',
        vehicleNumber: { not: null },
        // Same window the board uses: a shipment nobody closed is not a lorry we
        // should be spending full-resolution rows on.
        dispatchDate: { gte: new Date(Date.now() - ACTIVE_DISPATCH_DAYS * 24 * 3_600_000) },
      },
      select: { vehicleNumber: true },
    }),
    // The inbound equivalent of that window. A booking is live while its
    // purchase order is still PENDING - stock-in moves the PO to ARRIVED, which
    // drops the lorry off this list by itself with no status of its own to keep
    // in step. The date floor is the same fourteen days, for a booking the
    // office never dismissed.
    prisma.transportConfirmation.findMany({
      where: {
        direction: 'INBOUND',
        status: { in: ['WAITING', 'CONFIRMED'] },
        lorryNumber: { not: null },
        createdAt: { gte: new Date(Date.now() - ACTIVE_DISPATCH_DAYS * 24 * 3_600_000) },
        purchaseOrder: { status: 'PENDING' },
      },
      select: { lorryNumber: true },
    }),
    // An empty lorry coming in to load. Live while its slot is confirmed and
    // unloaded - raising the dispatch sets the slot LOADED, which drops the
    // plate off this list by itself. The window is the slot's own day plus a
    // few either side, matching the arrivals board.
    prisma.dispatchSlot.findMany({
      where: {
        status: 'CONFIRMED',
        lorryNumber: { not: null },
        saleDispatchId: null,
        date: {
          gte: new Date(Date.now() - 3 * 24 * 3_600_000),
          lte: new Date(Date.now() + 7 * 24 * 3_600_000),
        },
      },
      select: { lorryNumber: true },
    }),
  ]);

  const plates = new Set<string>();
  for (const r of dispatches) {
    const plate = normaliseVehicleNumber(r.vehicleNumber ?? '');
    if (plate) plates.add(plate);
  }
  for (const r of [...arrivals, ...loadingSlots]) {
    const plate = normaliseVehicleNumber(r.lorryNumber ?? '');
    if (plate) plates.add(plate);
  }
  activePlates = { at: Date.now(), plates };
  return plates;
}

/**
 * Drop the cached plate list - called when a dispatch is created or closed, and
 * when an inbound booking is filed. A booking that arrives mid-poll-cycle would
 * otherwise spend up to the TTL in the thinned feed, which is exactly the
 * window in which a lorry already close to the factory crosses both rings.
 */
export function invalidateActiveDispatchPlates(): void {
  activePlates = null;
}

/**
 * Should this reading become a row?
 *
 * Yes for anything on one of our dispatches. For the rest of the transporter's
 * fleet, only when it carries real news: a gap, a move, or a state change.
 */
function shouldStore(ping: ParsedPing, status: string | undefined, isOurs: boolean): boolean {
  const prev = lastStored.get(ping.vehicleNumber);
  if (!prev) return true;
  // Same device timestamp as the last row: the vehicle has not reported since
  // we last looked. The unique key would reject it anyway.
  if (ping.recordedAt.getTime() <= prev.recordedAt) return false;
  if (isOurs) return true;
  if (ping.recordedAt.getTime() - prev.recordedAt >= IDLE_MIN_GAP_MS) return true;
  if (status && status !== prev.status) return true;
  return metresBetween(prev.latitude, prev.longitude, ping.latitude, ping.longitude) >= IDLE_MIN_MOVE_M;
}

/* ------------------------------------------------------------------- fetch */

interface LocanixVehicle {
  vehicle?: string;
  status?: string;
  heading?: number;
  odometer?: number;
  [key: string]: unknown;
}

interface LocanixFeed {
  ok?: boolean;
  error?: string;
  retryAfterSeconds?: number;
  siteName?: string;
  vehicleCount?: number;
  vehicles?: LocanixVehicle[];
}

/**
 * One call to the provider. Separated from the storing so the manual "refresh
 * now" button and the cron tick share exactly one definition of the request.
 */
export async function fetchLocanixFleet(signal?: AbortSignal): Promise<LocanixFeed> {
  const cfg = locanixConfig();
  if (!cfg.apiKey) throw new Error('LOCANIX_API_KEY is not set on this server');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  signal?.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    const res = await fetch(cfg.baseUrl, {
      method: 'GET',
      headers: { 'X-Api-Key': cfg.apiKey, Accept: 'application/json' },
      signal: controller.signal,
    });
    const text = await res.text();
    let body: LocanixFeed;
    try {
      body = JSON.parse(text) as LocanixFeed;
    } catch {
      throw new Error(`Provider returned ${res.status} with a non-JSON body: ${text.slice(0, 200)}`);
    }
    // Their rate limit comes back as 200 + {ok:false}, not a 429, so the status
    // code alone is not enough to tell a refusal from a feed.
    if (body.ok === false || (!res.ok && !Array.isArray(body.vehicles))) {
      const err = new Error(body.error || `Provider returned HTTP ${res.status}`);
      (err as Error & { retryAfterSeconds?: number }).retryAfterSeconds = body.retryAfterSeconds;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------- poll */

/**
 * Fetch the fleet and store what is new.
 *
 * Never throws: the cron must not be able to die, and the manual refresh wants
 * the reason on screen rather than a 500. The failure lands in `lastResult`,
 * which the Vehicle Tracking page shows as the provider's health.
 */
export async function pollLocanix(opts: { force?: boolean } = {}): Promise<LocanixPollResult> {
  const started = Date.now();
  const base: LocanixPollResult = {
    ok: false, at: new Date().toISOString(), fetched: 0, parsed: 0, kept: 0,
    stored: 0, onDispatch: 0, rejected: [], tookMs: 0,
  };

  const cfg = locanixConfig();
  if (!cfg.configured) {
    return (lastResult = { ...base, error: 'LOCANIX_API_KEY is not set on this server', tookMs: 0 });
  }
  if (polling) return lastResult ?? { ...base, error: 'A poll is already running' };
  if (!opts.force && Date.now() < notBefore) {
    return lastResult ?? { ...base, error: 'Rate limited by the provider; standing down' };
  }

  polling = true;
  try {
    const feed = await fetchLocanixFleet();
    const vehicles = Array.isArray(feed.vehicles) ? feed.vehicles : [];
    const ours = await getActiveDispatchPlates();
    const now = new Date();

    const rejected: { vehicle: string; reason: string }[] = [];
    const toStore: { ping: ParsedPing; row: LocanixVehicle; isOurs: boolean }[] = [];
    let parsed = 0;
    let onDispatch = 0;

    for (const row of vehicles) {
      const result = parsePingRecord(row, now);
      if ('error' in result) {
        rejected.push({ vehicle: String(row.vehicle ?? '?'), reason: result.error });
        continue;
      }
      parsed += 1;
      const ping = result.ping;
      const isOurs = ours.has(ping.vehicleNumber);
      if (isOurs) onDispatch += 1;
      const status = typeof row.status === 'string' ? row.status : undefined;
      if (shouldStore(ping, status, isOurs)) toStore.push({ ping, row, isOurs });
    }

    let stored = 0;
    if (toStore.length > 0) {
      const result = await prisma.vehiclePing.createMany({
        data: toStore.map(({ ping, row, isOurs }) => ({
          provider: 'LOCANIX',
          vehicleNumber: ping.vehicleNumber,
          vehicleLabel: ping.vehicleLabel,
          latitude: ping.latitude,
          longitude: ping.longitude,
          speedKmph: ping.speedKmph,
          address: ping.address,
          ignition: ping.ignition,
          headingDeg: typeof row.heading === 'number' ? row.heading : null,
          providerStatus: typeof row.status === 'string' ? row.status.slice(0, 32) : null,
          odometerRaw: typeof row.odometer === 'number' ? row.odometer : null,
          recordedAt: ping.recordedAt,
          // The untouched payload, but only for lorries carrying one of our
          // consignments. It is the widest column on the table and most of the
          // feed is someone else's vehicle: keeping it for all 145 is most of
          // the table's size for rows nobody will ever open. The parsed
          // columns above are kept either way, so a thinned row is still a
          // position on a map - what is lost is only the field-by-field
          // argument with the provider, which is a conversation we only ever
          // have about our own trips.
          raw: isOurs ? (row as object) : undefined,
        })),
        skipDuplicates: true,
      });
      stored = result.count;

      // Only remember what we actually asked the database to hold, so a failed
      // write cannot make the next tick think it already has the fix.
      for (const { ping, row } of toStore) {
        lastStored.set(ping.vehicleNumber, {
          recordedAt: ping.recordedAt.getTime(),
          latitude: ping.latitude,
          longitude: ping.longitude,
          status: typeof row.status === 'string' ? row.status : undefined,
        });
      }
    }

    notBefore = 0;
    lastResult = {
      ok: true,
      at: new Date().toISOString(),
      fetched: vehicles.length,
      parsed,
      kept: toStore.length,
      stored,
      onDispatch,
      rejected,
      tookMs: Date.now() - started,
    };
    logger.info(`[locanix] ${stored}/${vehicles.length} stored (${onDispatch} on dispatch)`);

    // Now that the positions are current, see whether any arriving lorry has
    // crossed an approach ring. Here rather than on a schedule of its own: this
    // tick is the moment the data changed, and a cron would only ever be
    // reading a staler version of what we are holding right now.
    //
    // Deliberately NOT awaited into the poll result. The sweep sends WhatsApps,
    // and a slow or failing provider there must not stretch or fail a poll tick
    // whose job - storing the fixes - is already done. Lazily imported for the
    // same reason it is fire-and-forget: the notifier pulls in a good part of
    // the app, on a server where most ticks have nothing arriving.
    if (stored > 0) {
      void import('./inboundArrivals.service.js')
        .then((m) => m.sweepApproachRings())
        .catch((err) => logger.warn(`[arrivals] ring sweep failed: ${(err as Error)?.message ?? err}`));
    }

    return lastResult;
  } catch (err) {
    const retryAfter = (err as Error & { retryAfterSeconds?: number }).retryAfterSeconds;
    if (typeof retryAfter === 'number' && retryAfter > 0) {
      notBefore = Date.now() + Math.min(retryAfter, 120) * 1000;
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[locanix] poll failed: ${message}`);
    lastResult = { ...base, error: message, tookMs: Date.now() - started };
    return lastResult;
  } finally {
    polling = false;
  }
}
