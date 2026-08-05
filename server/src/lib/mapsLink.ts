import { logger } from './logger.js';

/**
 * Resolves a Google Maps share link (the `maps.app.goo.gl` short links this
 * app stores on Party.locationLink) to a lat/lng pair, purely by following
 * the redirect and reading coordinates out of the final URL - the same thing
 * a browser does when a driver taps the link. No Maps API key required.
 *
 * Needed because the WhatsApp "driver" template (rvp_driver) has an
 * approved Location header component, and Fast2SMS's Meta-format send for
 * that header wants real latitude/longitude - see whatsapp.service.ts.
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

const cache = new Map<string, { lat: number; lng: number } | null>();

function extractCoords(text: string): { lat: number; lng: number } | null {
  for (const pattern of COORD_PATTERNS) {
    const m = text.match(pattern);
    if (m) return { lat: Number(m[1]), lng: Number(m[2]) };
  }
  return null;
}

/** lat/lng from a Google Maps link, or null when it can't be resolved. Never throws. */
export async function resolveLatLngFromMapsLink(
  link: string | null | undefined,
): Promise<{ lat: number; lng: number } | null> {
  if (!link) return null;
  if (cache.has(link)) return cache.get(link)!;

  const result = await (async () => {
    try {
      const res = await fetch(link, {
        redirect: 'follow',
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const fromUrl = extractCoords(res.url || link);
      if (fromUrl) return fromUrl;
      // A short link occasionally lands on an interstitial HTML page instead of
      // redirecting the query string itself - the coordinates are still in the body.
      const body = await res.text();
      return extractCoords(body);
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
