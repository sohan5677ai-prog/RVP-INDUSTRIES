import { logger } from './logger.js';

/**
 * Road distance between two Indian PIN codes, for the E-Way Bill's
 * "Approx Distance".
 *
 * NIC works this out itself from the two PIN codes when a bill is raised with
 * Distance 0 - but it never hands the figure back, and the official print is
 * rendered from OUR record, so a bill raised that way prints "0 KM". We
 * therefore have to arrive at the number ourselves and file it, which makes the
 * printed copy and the NIC record agree by construction.
 *
 * NIC's own figure comes from MapmyIndia; ours comes from OpenStreetMap. They
 * are not identical, but NIC only rejects a distance that OVERSHOOTS its own by
 * more than 10%, and road routing between the same two points agrees far more
 * closely than that. Cross-checked on the Punganur → Surat run: OSM says 1248
 * km, and the validity NIC granted for its own calculation (7 days = one per
 * 200 km) puts its figure in 1201-1400 km.
 *
 * Two free, keyless services, both cached in-process because a lorry route
 * repeats for months:
 *   - Nominatim (OpenStreetMap) resolves a PIN code to a point
 *   - OSRM routes between the two points
 * Set GOOGLE_MAPS_API_KEY to use the Google Distance Matrix instead, which is
 * closer to what MapmyIndia reports and has no usage-policy limits.
 */

// Nominatim's usage policy requires an identifying User-Agent and at most one
// request a second. We make two per new route and none for a repeat one.
const USER_AGENT = 'RVP-ERP/1.0 (E-Way Bill distance; +https://github.com/sohan5677ai-prog/RVP-INDUSTRIES)';
const REQUEST_TIMEOUT_MS = 15_000;
const NOMINATIM_MIN_GAP_MS = 1_100;

const geocodeCache = new Map<string, { lat: number; lon: number } | null>();
const distanceCache = new Map<number, number>();

let nominatimChain: Promise<unknown> = Promise.resolve();
let lastNominatimAt = 0;

/** Serialises Nominatim calls and keeps them >1s apart, per its usage policy. */
function throttleNominatim<T>(fn: () => Promise<T>): Promise<T> {
  const run = nominatimChain.then(async () => {
    const wait = NOMINATIM_MIN_GAP_MS - (Date.now() - lastNominatimAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await fn();
    } finally {
      lastNominatimAt = Date.now();
    }
  });
  // Keep the chain alive even when a link rejects.
  nominatimChain = run.catch(() => {});
  return run;
}

function normalisePin(pin: string | null | undefined): string | null {
  const digits = (pin || '').replace(/\D/g, '');
  return /^[1-9][0-9]{5}$/.test(digits) ? digits : null;
}

/** PIN code -> lat/lon, or null when OSM doesn't know it. */
async function geocodePincode(pin: string): Promise<{ lat: number; lon: number } | null> {
  if (geocodeCache.has(pin)) return geocodeCache.get(pin)!;

  const point = await throttleNominatim(async () => {
    const url = `https://nominatim.openstreetmap.org/search?postalcode=${pin}&country=India&format=json&limit=1`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Nominatim returned ${res.status}`);
    const hits = (await res.json()) as Array<{ lat: string; lon: string }>;
    const hit = hits?.[0];
    if (!hit) return null;
    return { lat: Number(hit.lat), lon: Number(hit.lon) };
  });

  geocodeCache.set(pin, point);
  return point;
}

/** Metres by road between two points, via the public OSRM router. */
async function osrmMetres(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
): Promise<number | null> {
  const url = `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`;
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`OSRM returned ${res.status}`);
  const json = (await res.json()) as { routes?: Array<{ distance?: number }> };
  return json.routes?.[0]?.distance ?? null;
}

/** Metres by road, straight from the Google Distance Matrix (when keyed). */
async function googleMetres(fromPin: string, toPin: string, key: string): Promise<number | null> {
  const params = new URLSearchParams({
    origins: `${fromPin},India`,
    destinations: `${toPin},India`,
    mode: 'driving',
    key,
  });
  const res = await fetch(`https://maps.googleapis.com/maps/api/distancematrix/json?${params}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Google Distance Matrix returned ${res.status}`);
  const json = (await res.json()) as {
    rows?: Array<{ elements?: Array<{ status?: string; distance?: { value?: number } }> }>;
  };
  const element = json.rows?.[0]?.elements?.[0];
  if (element?.status !== 'OK') return null;
  return element.distance?.value ?? null;
}

/**
 * Road distance in whole km between two Indian PIN codes, or null when it
 * can't be worked out (unknown PIN code, or the routing service is down).
 * Never throws - the caller decides what an unknown distance means.
 */
export async function roadDistanceKm(
  fromPincode: string | null | undefined,
  toPincode: string | null | undefined,
): Promise<number | null> {
  const from = normalisePin(fromPincode);
  const to = normalisePin(toPincode);
  if (!from || !to) return null;
  if (from === to) return 1; // same PIN code: a local run, but never 0 km

  const cacheKey = Number(`${from}${to}`);
  const cached = distanceCache.get(cacheKey);
  if (cached) return cached;

  try {
    let metres: number | null = null;

    const googleKey = process.env.GOOGLE_MAPS_API_KEY;
    if (googleKey) {
      metres = await googleMetres(from, to, googleKey);
    }
    if (metres == null) {
      const [a, b] = [await geocodePincode(from), await geocodePincode(to)];
      if (!a || !b) {
        logger.warn(`[distance] no OSM point for PIN ${!a ? from : to} - cannot calculate the E-Way Bill distance`);
        return null;
      }
      metres = await osrmMetres(a, b);
    }
    if (metres == null) return null;

    // Round up: a whole km, and never 0 for a route that exists.
    const km = Math.max(1, Math.ceil(metres / 1000));
    distanceCache.set(cacheKey, km);
    return km;
  } catch (err) {
    logger.warn(`[distance] ${from} -> ${to} could not be calculated: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
