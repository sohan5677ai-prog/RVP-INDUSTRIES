import { describe, it, expect } from 'vitest';
import {
  decodePolyline,
  cumulativeKm,
  progressAlongRoute,
  OFF_ROUTE_KM,
  type LatLng,
} from './routeGeometry.js';
import { kmBetween } from './gpsPlaces.js';

describe('decodePolyline', () => {
  it('decodes the example from Google’s own specification', () => {
    // The canonical test vector: (38.5, -120.2), (40.7, -120.95), (43.252, -126.453).
    const points = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(points).toHaveLength(3);
    expect(points[0].lat).toBeCloseTo(38.5, 5);
    expect(points[0].lng).toBeCloseTo(-120.2, 5);
    expect(points[2].lat).toBeCloseTo(43.252, 5);
    expect(points[2].lng).toBeCloseTo(-126.453, 5);
  });

  it('returns nothing for an empty or missing value', () => {
    expect(decodePolyline('')).toEqual([]);
    expect(decodePolyline(null)).toEqual([]);
    expect(decodePolyline(undefined)).toEqual([]);
  });

  it('yields the points it managed rather than throwing on a truncated string', () => {
    // A clipped cache entry should degrade to a shorter route, not break a
    // dispatch board.
    const whole = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
    const points = decodePolyline(whole.slice(0, 12));
    expect(points.length).toBeGreaterThanOrEqual(1);
    expect(points.length).toBeLessThan(3);
  });
});

describe('cumulativeKm', () => {
  it('starts at zero and rises monotonically', () => {
    const points: LatLng[] = [
      { lat: 13.0, lng: 78.0 },
      { lat: 13.5, lng: 78.0 },
      { lat: 14.0, lng: 78.0 },
    ];
    const cumulative = cumulativeKm(points);
    expect(cumulative[0]).toBe(0);
    expect(cumulative[1]).toBeGreaterThan(0);
    expect(cumulative[2]).toBeGreaterThan(cumulative[1]);
  });

  it('matches the great-circle distance along a straight meridian', () => {
    const points: LatLng[] = [
      { lat: 13.0, lng: 78.0 },
      { lat: 14.0, lng: 78.0 },
    ];
    const direct = kmBetween(13, 78, 14, 78);
    expect(cumulativeKm(points)[1]).toBeCloseTo(direct, 6);
  });
});

/** A due-north line from the factory, one point every 0.1 degrees (~11 km). */
const NORTH: LatLng[] = Array.from({ length: 11 }, (_, i) => ({
  lat: 13.3658707 + i * 0.1,
  lng: 78.5882473,
}));
const NORTH_CUM = cumulativeKm(NORTH);

describe('progressAlongRoute', () => {
  it('reports nothing at the start and everything at the end', () => {
    const atStart = progressAlongRoute(NORTH, NORTH_CUM, NORTH[0])!;
    expect(atStart.coveredKm).toBeCloseTo(0, 3);
    expect(atStart.progressPct).toBeCloseTo(0, 3);

    const atEnd = progressAlongRoute(NORTH, NORTH_CUM, NORTH[NORTH.length - 1])!;
    expect(atEnd.remainingKm).toBeCloseTo(0, 3);
    expect(atEnd.progressPct).toBeCloseTo(100, 3);
  });

  it('splits the route at the halfway point', () => {
    const middle = progressAlongRoute(NORTH, NORTH_CUM, NORTH[5])!;
    const total = NORTH_CUM[NORTH_CUM.length - 1];
    expect(middle.coveredKm).toBeCloseTo(total / 2, 1);
    expect(middle.remainingKm).toBeCloseTo(total / 2, 1);
    expect(middle.progressPct).toBeCloseTo(50, 1);
  });

  it('covered plus remaining is always the whole route', () => {
    const total = NORTH_CUM[NORTH_CUM.length - 1];
    for (const lat of [13.4, 13.72, 14.01, 14.25]) {
      const p = progressAlongRoute(NORTH, NORTH_CUM, { lat, lng: 78.5882473 })!;
      expect(p.coveredKm + p.remainingKm).toBeCloseTo(total, 3);
    }
  });

  it('projects a fix beside the road onto it, and measures the gap', () => {
    // 0.02 degrees of longitude east of the line - a couple of km at this
    // latitude, which is a lorry on a service road, not a diversion.
    const beside = progressAlongRoute(NORTH, NORTH_CUM, { lat: 13.8658707, lng: 78.6082473 })!;
    expect(beside.offRouteKm).toBeGreaterThan(0);
    expect(beside.offRouteKm).toBeLessThan(OFF_ROUTE_KM);
    // Still placed at the right point along the route.
    expect(beside.progressPct).toBeCloseTo(50, 2);
  });

  it('flags a lorry that has genuinely left the route', () => {
    // A degree of longitude away - over 100 km off the line.
    const gone = progressAlongRoute(NORTH, NORTH_CUM, { lat: 13.8658707, lng: 79.6 })!;
    expect(gone.offRouteKm).toBeGreaterThan(OFF_ROUTE_KM);
  });

  it('clamps a fix beyond either end instead of running off the line', () => {
    // South of the origin: the nearest point on the route is its start, so the
    // lorry has covered nothing - not a negative distance.
    const before = progressAlongRoute(NORTH, NORTH_CUM, { lat: 13.0, lng: 78.5882473 })!;
    expect(before.coveredKm).toBeCloseTo(0, 3);
    expect(before.remainingKm).toBeCloseTo(NORTH_CUM[NORTH_CUM.length - 1], 3);

    // Past the destination: nothing left to run, and never a negative.
    const past = progressAlongRoute(NORTH, NORTH_CUM, { lat: 15.0, lng: 78.5882473 })!;
    expect(past.remainingKm).toBeCloseTo(0, 3);
    expect(past.remainingKm).toBeGreaterThanOrEqual(0);
  });

  it('refuses a line it cannot use rather than inventing a figure', () => {
    expect(progressAlongRoute([], [], { lat: 13, lng: 78 })).toBeNull();
    expect(progressAlongRoute([NORTH[0]], [0], { lat: 13, lng: 78 })).toBeNull();
    // Mismatched lengths mean the prefix sums are not this line's.
    expect(progressAlongRoute(NORTH, [0, 1], { lat: 13, lng: 78 })).toBeNull();
  });

  it('survives a route with duplicated points', () => {
    // Provider geometry does contain zero-length segments; a divide by the
    // segment length would be NaN all the way out to the screen.
    const dupes: LatLng[] = [
      { lat: 13.0, lng: 78.0 },
      { lat: 13.0, lng: 78.0 },
      { lat: 13.5, lng: 78.0 },
    ];
    const p = progressAlongRoute(dupes, cumulativeKm(dupes), { lat: 13.25, lng: 78.0 })!;
    expect(Number.isFinite(p.remainingKm)).toBe(true);
    expect(Number.isFinite(p.progressPct)).toBe(true);
  });
});
