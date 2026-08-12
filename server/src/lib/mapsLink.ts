import { logger } from './logger.js';

/**
 * Resolves a Google Maps share link (the `maps.app.goo.gl` short links this
 * app stores on Party.locationLink) to a lat/lng pair, purely by following
 * the redirect and reading coordinates out of the final URL - the same thing
 * a browser does when a driver taps the link. No Maps API key required.
 *
 * Feeds the WhatsApp Location header on the driver template (driver_industries),
 * whose Meta-format send wants real latitude/longitude rather than a link - see
 * notifyDispatchDriver in whatsapp.service.ts. Without coordinates that template
 * cannot go out at all, so what this resolves decides which drivers get messaged.
 *
 * Roughly half of Google's share links resolve this way. A business-listing link
 * ("place/Hari+Om+Gum+Industries/data=!4m2!3m1!1s0x3be0...") carries a place id
 * and no coordinates anywhere in the redirect or the page body - only a pin-drop
 * or map-view link carries `@lat,lng`. For those, paste the plain coordinates
 * ("21.132722, 72.833611" - long-press the pin in Google Maps and tap the
 * numbers to copy) into the party's location field instead; `parseLatLng`
 * accepts that form directly and skips the network entirely.
 */

const REQUEST_TIMEOUT_MS = 10_000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Coordinate shapes seen across Google Maps URL variants, checked in order.
const COORD_PATTERNS: RegExp[] = [
  /@(-?\d+\.\d+),(-?\d+\.\d+)/, // .../@lat,lng,17z
  /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, // place-page data blob
  /[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/, // ?q=lat,lng
  /[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)/, // ?ll=lat,lng
];

// A field holding nothing but coordinates: "21.132722, 72.833611" - what
// Google Maps copies when you long-press a spot and tap the numbers.
const BARE_COORDS = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

const cache = new Map<string, { lat: number; lng: number } | null>();

function extractCoords(text: string): { lat: number; lng: number } | null {
  for (const pattern of COORD_PATTERNS) {
    const m = text.match(pattern);
    if (m) return { lat: Number(m[1]), lng: Number(m[2]) };
  }
  return null;
}

/** True for a coordinate pair that could be a real place on Earth. */
function plausible(c: { lat: number; lng: number }): boolean {
  return Math.abs(c.lat) <= 90 && Math.abs(c.lng) <= 180 && !(c.lat === 0 && c.lng === 0);
}

/**
 * Coordinates readable from the stored value without any network call - either
 * bare "lat,lng" or a long maps URL that already spells them out. Null when the
 * value needs the redirect followed (a short link) or has no coordinates at all.
 */
export function parseLatLng(raw: string | null | undefined): { lat: number; lng: number } | null {
  if (!raw) return null;
  const bare = raw.match(BARE_COORDS);
  const coords = bare ? { lat: Number(bare[1]), lng: Number(bare[2]) } : extractCoords(raw);
  return coords && plausible(coords) ? coords : null;
}

/**
 * The shortest link that opens a pin at these coordinates - about 45
 * characters, against the 300-plus of a copied Google Maps place URL, which
 * wrapped over eight lines in the driver's message and buried the trip details
 * above it. Six decimals is ~10 cm; trailing zeros are dropped by Number.
 */
export function coordUrl(coords: { lat: number; lng: number }): string {
  const round = (n: number) => Number(n.toFixed(6));
  return `https://maps.google.com/?q=${round(coords.lat)},${round(coords.lng)}`;
}

/**
 * A tappable maps URL for the driver's message. Coordinates - typed in bare, or
 * already spelled out in a long URL - become the short `?q=` link above; a
 * share link with nothing to read passes through unchanged.
 */
export function mapsUrlFor(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const coords = parseLatLng(raw);
  return coords ? coordUrl(coords) : raw.trim();
}

/** lat/lng from a Google Maps link, or null when it can't be resolved. Never throws. */
export async function resolveLatLngFromMapsLink(
  link: string | null | undefined,
): Promise<{ lat: number; lng: number } | null> {
  if (!link) return null;
  const direct = parseLatLng(link);
  if (direct) return direct;
  if (cache.has(link)) return cache.get(link)!;

  const result = await (async () => {
    try {
      const res = await fetch(link, {
        redirect: 'follow',
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const fromUrl = extractCoords(res.url || link);
      if (fromUrl) return plausible(fromUrl) ? fromUrl : null;
      // A short link occasionally lands on an interstitial HTML page instead of
      // redirecting the query string itself - the coordinates are still in the body.
      const body = await res.text();
      const fromBody = extractCoords(body);
      return fromBody && plausible(fromBody) ? fromBody : null;
    } catch (err) {
      logger.warn(
        `[maps-link] could not resolve coordinates from ${link}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  })();

  cache.set(link, result);
  return result;
}
