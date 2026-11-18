import { kmBetween } from './gpsPlaces.js';

/**
 * Where a lorry is along a route it was given, answered without a network call.
 *
 * This is what makes live road distance affordable. A lane is routed once (see
 * route.service.ts) and its geometry kept; from then on every position report -
 * one every two minutes, per lorry - is answered by projecting that fix onto
 * the stored line and summing what is left. No provider is asked anything, so
 * the marginal cost of tracking a lorry for a week is zero.
 *
 * It is also more honest than the straight-line arithmetic it replaces. A fix
 * 300 km from the buyer in a straight line can be 420 km by road around a
 * range, and ROAD_FACTOR's flat 1.25 cannot know which. Measuring along the
 * actual road does.
 *
 * And it answers a question straight-line distance cannot ask at all: whether
 * the lorry is still ON the route. A fix twenty km off the line is a diversion,
 * a wrong turn, or a stop that should not be happening - and nobody would have
 * seen it in a distance that was merely getting shorter.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * Decode an encoded polyline (Google's algorithm, precision 5) into points.
 *
 * Written out rather than taken from a package: it is thirty lines, the format
 * has not changed since 2006, and both providers worth using here emit it. A
 * malformed string yields the points decoded so far instead of throwing - a
 * truncated route is still a usable route, and a cached lane that somehow got
 * clipped should degrade to a shorter line, not break a dispatch board.
 */
export function decodePolyline(encoded: string | null | undefined, precision = 5): LatLng[] {
  if (!encoded) return [];
  const factor = 10 ** precision;
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 1;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index++) - 63 - 1;
      if (Number.isNaN(b) || b < 0) return points;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f && index < encoded.length);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 1;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63 - 1;
      if (Number.isNaN(b) || b < 0) return points;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f && index < encoded.length);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / factor, lng: lng / factor });
  }
  return points;
}

/**
 * Cumulative kilometres along a line, one entry per point.
 *
 * Computed once per lane and held with it, so a projection is a binary-search's
 * worth of work rather than a walk of the whole route. A long lane is a few
 * thousand points; doing this per ping per lorry is the kind of arithmetic that
 * looks free until there are forty lorries on the board.
 */
export function cumulativeKm(points: LatLng[]): number[] {
  const out: number[] = new Array(points.length);
  let total = 0;
  for (let i = 0; i < points.length; i += 1) {
    if (i > 0) {
      total += kmBetween(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
    }
    out[i] = total;
  }
  return out;
}

/**
 * The point on segment a->b closest to p, as a fraction along that segment.
 *
 * Plane geometry on degrees, with longitude squeezed by cos(latitude) so a
 * degree east is worth what it is actually worth at this latitude. Over a
 * polyline segment - tens or hundreds of metres - the curvature of the earth is
 * far below the accuracy of the fix that is being projected, so the exact
 * spherical form would be arithmetic spent on nothing.
 */
function projectionFraction(a: LatLng, b: LatLng, p: LatLng): number {
  const latScale = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  const ax = a.lng * latScale;
  const ay = a.lat;
  const bx = b.lng * latScale;
  const by = b.lat;
  const px = p.lng * latScale;
  const py = p.lat;

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  // A zero-length segment - duplicated points do occur in provider geometry.
  if (lenSq === 0) return 0;
  const t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  return Math.max(0, Math.min(1, t));
}

/** A point interpolated along a segment. */
function along(a: LatLng, b: LatLng, t: number): LatLng {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

export interface RouteProgress {
  /** Km from the start of the route to the lorry's projected position. */
  coveredKm: number;
  /** Km from that position to the end of the route. */
  remainingKm: number;
  /** 0-100 along the route. */
  progressPct: number;
  /**
   * How far the fix is from the route itself. The off-route signal: a lorry on
   * the road sits within a few hundred metres of the line, limited mostly by
   * how coarsely the provider drew it.
   */
  offRouteKm: number;
  /** Index of the segment the lorry was matched to, for debugging a bad match. */
  segmentIndex: number;
}

/**
 * Match a fix to a route and say how much of it is left.
 *
 * The nearest point on the whole line wins, which is the right rule for a lorry
 * but not a free one: a route that doubles back near itself - a city bypass
 * crossing an older road, a lane that returns through the same junction - has
 * two places a fix could belong to, and this picks whichever is geometrically
 * closer rather than whichever the lorry has actually reached. On a point-to-
 * point lane that is almost always the same answer. Where it is not, the
 * progress figure jumps backwards for a few fixes and then recovers, which is
 * why `remainingKm` is reported rather than used to decide anything
 * irreversible.
 */
export function progressAlongRoute(
  points: LatLng[],
  cumulative: number[],
  fix: LatLng,
): RouteProgress | null {
  if (points.length < 2 || cumulative.length !== points.length) return null;

  let bestDistance = Infinity;
  let bestIndex = 0;
  let bestFraction = 0;

  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const t = projectionFraction(a, b, fix);
    const at = along(a, b, t);
    const d = kmBetween(fix.lat, fix.lng, at.lat, at.lng);
    if (d < bestDistance) {
      bestDistance = d;
      bestIndex = i;
      bestFraction = t;
    }
  }

  const totalKm = cumulative[cumulative.length - 1];
  const segmentKm = cumulative[bestIndex + 1] - cumulative[bestIndex];
  const coveredKm = cumulative[bestIndex] + segmentKm * bestFraction;
  const remainingKm = Math.max(0, totalKm - coveredKm);

  return {
    coveredKm,
    remainingKm,
    progressPct: totalKm > 0 ? Math.max(0, Math.min(100, (coveredKm / totalKm) * 100)) : 0,
    offRouteKm: bestDistance,
    segmentIndex: bestIndex,
  };
}

/**
 * How far off the line counts as off the route.
 *
 * Generous on purpose. Provider geometry is simplified, a service road runs
 * beside the highway, and a GPS fix on a lorry is not survey-grade - so a
 * tight threshold would cry diversion at every truck stop. Five km is past all
 * of that and still well inside "he has left the road he was given".
 */
export const OFF_ROUTE_KM = 5;
