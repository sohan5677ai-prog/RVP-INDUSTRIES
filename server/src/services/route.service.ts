import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { kmBetween, ROAD_FACTOR } from '../lib/gpsPlaces.js';
import { decodePolyline, cumulativeKm, type LatLng } from '../lib/routeGeometry.js';

/**
 * Road distance between two points, asked of a routing provider once per lane
 * and then kept forever.
 *
 * Three decisions shape this file.
 *
 * 1. **One call per lane, not per position.** A lorry reports every two
 *    minutes. Routing each fix would be thousands of calls per trip to
 *    re-measure a road that has not moved. So a lane is routed once, its
 *    distance and geometry stored in RouteLane, and every later position is
 *    answered by projecting onto that geometry (routeGeometry.ts). The marginal
 *    cost of watching a lorry all week is zero.
 *
 * 2. **No key configured is a supported state, not a failure.** There is no
 *    routing key on this server today, and the dispatch board has to keep
 *    working. Without one, a lane is measured as great-circle distance times
 *    ROAD_FACTOR - exactly what the board did before - and labelled
 *    PIN_STRAIGHT so no screen presents it as a measurement. Set a key and the
 *    same lanes re-measure themselves as PIN_ROUTED with no code change.
 *
 * 3. **The cache key is rounded.** A pin re-copied out of Google comes back
 *    differing in the sixth decimal. Keyed on raw coordinates, every dispatch
 *    to the same buyer would miss the cache and buy the route again.
 */

/* ---------------------------------------------------------------- the config */

export type RouteProvider = 'NONE' | 'MAPBOX' | 'GOOGLE' | 'OSRM';

/**
 * Which provider to use, from the environment.
 *
 * Mapbox and Google both want a key and both route India well. OSRM needs no
 * key and can be pointed at a self-hosted instance with ROUTE_OSRM_URL; the
 * public demo server is rate-limited and has no SLA, so it is opt-in rather
 * than a default anyone falls into.
 */
export function routeConfig() {
  const mapbox = process.env.MAPBOX_TOKEN?.trim();
  const google = process.env.GOOGLE_ROUTES_KEY?.trim();
  const osrm = process.env.ROUTE_OSRM_URL?.trim();
  const preferred = process.env.ROUTE_PROVIDER?.trim().toUpperCase();

  const available: RouteProvider[] = [];
  if (mapbox) available.push('MAPBOX');
  if (google) available.push('GOOGLE');
  if (osrm) available.push('OSRM');

  const provider: RouteProvider =
    preferred && available.includes(preferred as RouteProvider)
      ? (preferred as RouteProvider)
      : available[0] ?? 'NONE';

  return { provider, mapbox, google, osrm, available };
}

/** How long a cached lane is trusted. Roads change; not often. */
const LANE_TTL_DAYS = 180;
const REQUEST_TIMEOUT_MS = 12_000;

/* ------------------------------------------------------------------ the keys */

/**
 * Three decimals - about 111 m. Coarse enough that the same gate always lands
 * on one key, fine enough that two buyers on the same industrial road do not
 * share a lane.
 */
export function laneKey(point: LatLng): string {
  return `${point.lat.toFixed(3)},${point.lng.toFixed(3)}`;
}

/* ------------------------------------------------------------- the providers */

interface RoutedLane {
  roadKm: number;
  durationMin: number | null;
  polyline: string | null;
  provider: string;
}

/** Straight line times the usual Indian road ratio. The no-key path. */
function straightLine(from: LatLng, to: LatLng): RoutedLane {
  return {
    roadKm: kmBetween(from.lat, from.lng, to.lat, to.lng) * ROAD_FACTOR,
    durationMin: null,
    // No geometry, so there is nothing to project onto and the live figure
    // stays straight-line too. Honest rather than invented.
    polyline: null,
    provider: 'STRAIGHT',
  };
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function routeViaMapbox(from: LatLng, to: LatLng, token: string): Promise<RoutedLane> {
  const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`;
  const url =
    `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}` +
    `?overview=full&geometries=polyline&access_token=${encodeURIComponent(token)}`;
  const body = (await fetchJson(url)) as {
    routes?: { distance?: number; duration?: number; geometry?: string }[];
  };
  const route = body.routes?.[0];
  if (!route?.distance) throw new Error('no route returned');
  return {
    roadKm: route.distance / 1000,
    durationMin: route.duration ? Math.round(route.duration / 60) : null,
    polyline: route.geometry ?? null,
    provider: 'MAPBOX',
  };
}

async function routeViaGoogle(from: LatLng, to: LatLng, key: string): Promise<RoutedLane> {
  const body = (await fetchJson('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      // Routes bills by what you ask for, so ask for three fields.
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline',
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
      destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
      travelMode: 'DRIVE',
      // A loaded lorry is not a car, but asking for traffic-aware routing would
      // make the answer a function of when it was asked - and this answer is
      // cached for months. The static road is the right thing to store.
      routingPreference: 'TRAFFIC_UNAWARE',
    }),
  })) as {
    routes?: { distanceMeters?: number; duration?: string; polyline?: { encodedPolyline?: string } }[];
  };
  const route = body.routes?.[0];
  if (!route?.distanceMeters) throw new Error('no route returned');
  return {
    roadKm: route.distanceMeters / 1000,
    durationMin: route.duration ? Math.round(Number(route.duration.replace('s', '')) / 60) : null,
    polyline: route.polyline?.encodedPolyline ?? null,
    provider: 'GOOGLE',
  };
}

async function routeViaOsrm(from: LatLng, to: LatLng, baseUrl: string): Promise<RoutedLane> {
  const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`;
  const url = `${baseUrl.replace(/\/$/, '')}/route/v1/driving/${coords}?overview=full&geometries=polyline`;
  const body = (await fetchJson(url)) as {
    routes?: { distance?: number; duration?: number; geometry?: string }[];
  };
  const route = body.routes?.[0];
  if (!route?.distance) throw new Error('no route returned');
  return {
    roadKm: route.distance / 1000,
    durationMin: route.duration ? Math.round(route.duration / 60) : null,
    polyline: route.geometry ?? null,
    provider: 'OSRM',
  };
}

/* -------------------------------------------------------------- the lane read */

export interface Lane {
  roadKm: number;
  durationMin: number | null;
  polyline: string | null;
  provider: string;
  /** True when a routing provider actually drew this, not ROAD_FACTOR. */
  routed: boolean;
}

/**
 * The lane between two points, from the cache or newly measured.
 *
 * Never throws. A provider that is down, rate-limited or misconfigured falls
 * back to the straight-line figure and stores THAT, so a dispatch board does
 * not sit blank waiting for someone else's API - but it is stored with
 * provider 'STRAIGHT', so `routed` is false and the screens keep saying so.
 * `refreshLane` is how a lane measured that way gets re-asked later.
 */
export async function getLane(from: LatLng, to: LatLng): Promise<Lane> {
  const fromKey = laneKey(from);
  const toKey = laneKey(to);

  const cached = await prisma.routeLane
    .findUnique({ where: { fromKey_toKey: { fromKey, toKey } } })
    .catch(() => null);

  const fresh =
    cached && Date.now() - cached.fetchedAt.getTime() < LANE_TTL_DAYS * 24 * 3_600_000;

  // A cached straight-line lane is re-asked as soon as a provider appears,
  // rather than waiting out the TTL: the whole point of configuring a key is
  // that the next board render is better than the last.
  const cfg = routeConfig();
  const cachedIsStraight = cached?.provider === 'STRAIGHT';
  if (cached && fresh && !(cachedIsStraight && cfg.provider !== 'NONE')) {
    return {
      roadKm: cached.roadKm,
      durationMin: cached.durationMin,
      polyline: cached.polyline,
      provider: cached.provider,
      routed: cached.provider !== 'STRAIGHT',
    };
  }

  let lane: RoutedLane;
  try {
    if (cfg.provider === 'MAPBOX') lane = await routeViaMapbox(from, to, cfg.mapbox!);
    else if (cfg.provider === 'GOOGLE') lane = await routeViaGoogle(from, to, cfg.google!);
    else if (cfg.provider === 'OSRM') lane = await routeViaOsrm(from, to, cfg.osrm!);
    else lane = straightLine(from, to);
  } catch (err) {
    logger.warn(
      `[route] ${cfg.provider} could not route ${fromKey} -> ${toKey}: ${err instanceof Error ? err.message : String(err)}`,
    );
    lane = straightLine(from, to);
  }

  await prisma.routeLane
    .upsert({
      where: { fromKey_toKey: { fromKey, toKey } },
      create: {
        fromKey, toKey,
        fromLat: from.lat, fromLng: from.lng,
        toLat: to.lat, toLng: to.lng,
        roadKm: lane.roadKm,
        durationMin: lane.durationMin,
        polyline: lane.polyline,
        provider: lane.provider,
      },
      update: {
        roadKm: lane.roadKm,
        durationMin: lane.durationMin,
        polyline: lane.polyline,
        provider: lane.provider,
        fetchedAt: new Date(),
      },
    })
    .catch((err) => logger.warn(`[route] could not store lane ${fromKey} -> ${toKey}: ${err?.message ?? err}`));

  return { ...lane, routed: lane.provider !== 'STRAIGHT' };
}

/* ----------------------------------------------------- the decoded-lane cache */

interface DecodedLane {
  points: LatLng[];
  cumulative: number[];
}

/**
 * Decoded geometry, held in memory per lane.
 *
 * Decoding a long polyline and summing its segments is a few thousand
 * operations; doing it per lorry per board render is the kind of waste that
 * only shows up once the yard is busy. Keyed by the polyline string itself, so
 * a re-measured lane simply lands on a new entry and the stale one ages out.
 */
const decoded = new Map<string, DecodedLane>();
const DECODED_CACHE_LIMIT = 200;

export function decodeLane(polyline: string | null | undefined): DecodedLane | null {
  if (!polyline) return null;
  const hit = decoded.get(polyline);
  if (hit) return hit;

  const points = decodePolyline(polyline);
  if (points.length < 2) return null;
  const entry = { points, cumulative: cumulativeKm(points) };

  // Crude eviction - the oldest insertion goes. A fleet does not run hundreds
  // of distinct lanes at once, so this exists to bound memory, not to be clever.
  if (decoded.size >= DECODED_CACHE_LIMIT) {
    const oldest = decoded.keys().next().value;
    if (oldest !== undefined) decoded.delete(oldest);
  }
  decoded.set(polyline, entry);
  return entry;
}

/** Drop a lane and measure it again - for a road that has genuinely changed. */
export async function refreshLane(from: LatLng, to: LatLng): Promise<Lane> {
  await prisma.routeLane
    .delete({ where: { fromKey_toKey: { fromKey: laneKey(from), toKey: laneKey(to) } } })
    .catch(() => undefined);
  return getLane(from, to);
}
