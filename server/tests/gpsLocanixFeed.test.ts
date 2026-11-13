/**
 * The Locanix pull feed.
 *
 * The shapes here are copied from a real response, so if the provider renames
 * a field or changes the timestamp format these fail rather than the board
 * quietly going empty - which is the failure mode that matters, because an
 * empty board looks exactly like a fleet that happens to be parked.
 */
import { describe, it, expect } from 'vitest';
import { parsePingRecord, deriveState } from '../src/controllers/gps.controller.js';
import { resolvePlace, kmBetween, FACTORY } from '../src/lib/gpsPlaces.js';
import { metresBetween } from '../src/services/locanix.service.js';

const now = new Date('2026-11-13T20:20:00+05:30');

/** One vehicle, exactly as /api/standard-api returns it. */
const SAMPLE = {
  vehicle: 'GJ18-BV-6551',
  speed: 52,
  odometer: 1672916.01,
  status: 'Moving',
  latitude: 17.089472222222224,
  longitude: 79.26758,
  heading: 111,
  id: 8268,
  ignition: 'On',
  timestamp: '2026-11-13T20:15:31.000+05:30',
  timestampUTC: '2026-11-13T14:45:31.000Z',
};

function parse(record: unknown) {
  const out = parsePingRecord(record, now);
  if ('error' in out) throw new Error(`unexpected rejection: ${out.error}`);
  return out.ping;
}

describe('the provider feed as it actually arrives', () => {
  it('reads a vehicle row without any renaming on their side', () => {
    const ping = parse(SAMPLE);
    expect(ping.vehicleNumber).toBe('GJ18BV6551');
    // The label keeps their hyphens; the key does not, so a plate typed
    // "GJ18BV6551" at dispatch still matches.
    expect(ping.vehicleLabel).toBe('GJ18-BV-6551');
    expect(ping.latitude).toBeCloseTo(17.0894, 3);
    expect(ping.longitude).toBeCloseTo(79.2675, 3);
    expect(ping.speedKmph).toBe(52);
    expect(ping.ignition).toBe(true);
    expect(ping.recordedAt.toISOString()).toBe('2026-11-13T14:45:31.000Z');
  });

  it('reads their IST timestamp as IST, not as local time', () => {
    const ping = parse({ ...SAMPLE, timestamp: '2026-11-13T09:30:00+05:30' });
    expect(ping.recordedAt.toISOString()).toBe('2026-11-13T04:00:00.000Z');
  });

  it('takes "Off" as ignition off rather than as a truthy string', () => {
    expect(parse({ ...SAMPLE, ignition: 'Off' }).ignition).toBe(false);
  });

  it('drops the no-fix rows the feed carries (two of 145 on a live pull)', () => {
    const out = parsePingRecord({ ...SAMPLE, latitude: 0, longitude: 0 }, now);
    expect(out).toHaveProperty('error');
  });
});

describe('what the board calls a lorry', () => {
  it('trusts the provider status while the fix is fresh', () => {
    expect(deriveState('Moving', 52, 2)).toBe('MOVING');
    expect(deriveState('Idling', 0, 2)).toBe('IDLING');
    expect(deriveState('Parked', 0, 2)).toBe('PARKED');
    expect(deriveState('Offline', 0, 2)).toBe('OFFLINE');
  });

  it('calls a stale fix out of contact however the device described it', () => {
    // 93 of 145 vehicles on the live feed were "Offline" with fixes hours or
    // days old. Showing one of those as Moving would be a lie on the board.
    expect(deriveState('Moving', 52, 90)).toBe('OFFLINE');
  });

  it('falls back to speed when the provider sends no status', () => {
    expect(deriveState(null, 40, 1)).toBe('MOVING');
    expect(deriveState(null, 0, 1)).toBe('PARKED');
  });
});

describe('journey arithmetic', () => {
  it('resolves the destinations the office actually types', () => {
    expect(resolvePlace('Surat')?.name).toBe('Surat');
    expect(resolvePlace('surat (sachin)')?.name).toBe('Sachin, Surat');
    expect(resolvePlace('Nagar')?.name).toBe('Ahmednagar');
    expect(resolvePlace('')).toBeNull();
    expect(resolvePlace('somewhere nobody has heard of')).toBeNull();
  });

  it('measures Raichur to Surat at roughly its real straight-line distance', () => {
    const surat = resolvePlace('Surat')!;
    const km = kmBetween(FACTORY.latitude, FACTORY.longitude, surat.latitude, surat.longitude);
    expect(km).toBeGreaterThan(700);
    expect(km).toBeLessThan(820);
  });

  it('measures short hops in metres for the thinning rule', () => {
    // ~111 m of latitude.
    expect(metresBetween(16.2000, 77.3000, 16.2010, 77.3000)).toBeGreaterThan(100);
    expect(metresBetween(16.2000, 77.3000, 16.2010, 77.3000)).toBeLessThan(125);
    expect(metresBetween(16.2, 77.3, 16.2, 77.3)).toBe(0);
  });
});
