import { describe, it, expect } from 'vitest';
import {
  phaseOf,
  positionOf,
  DEFAULT_APPROACH_RING_KM,
  DEFAULT_GATE_RING_KM,
  POSITION_MAX_AGE_MINUTES,
  type ArrivalRings,
  type Fix,
} from './inboundArrivals.service.js';

const rings: ArrivalRings = {
  approachKm: DEFAULT_APPROACH_RING_KM,
  gateKm: DEFAULT_GATE_RING_KM,
  alertsEnabled: true,
};

describe('phaseOf', () => {
  it('calls an untracked lorry BOOKED, never approaching', () => {
    // The point of the distinction: without a fix there is nothing to measure,
    // and a board that promises an arrival it cannot see is worse than one that
    // admits it cannot.
    expect(phaseOf(null, rings)).toBe('BOOKED');
  });

  it('reads the rings inward', () => {
    expect(phaseOf(400, rings)).toBe('EN_ROUTE');
    expect(phaseOf(11, rings)).toBe('EN_ROUTE');
    expect(phaseOf(10, rings)).toBe('APPROACHING');
    expect(phaseOf(3, rings)).toBe('APPROACHING');
    expect(phaseOf(2, rings)).toBe('AT_GATE');
    expect(phaseOf(0, rings)).toBe('AT_GATE');
  });

  it('puts the ring boundary inside the tighter phase', () => {
    // A lorry reported at exactly the gate ring is at the gate, not merely
    // approaching: the cabin would rather raise a ticket one fix early than
    // one fix late.
    expect(phaseOf(rings.gateKm, rings)).toBe('AT_GATE');
    expect(phaseOf(rings.approachKm, rings)).toBe('APPROACHING');
  });

  it('still separates the two phases when the rings are close together', () => {
    const tight: ArrivalRings = { approachKm: 4, gateKm: 3, alertsEnabled: true };
    expect(phaseOf(4, tight)).toBe('APPROACHING');
    expect(phaseOf(3, tight)).toBe('AT_GATE');
  });
});


/**
 * A fix has to be recent enough to mean anything. GJ18BV1872 last reported on
 * 5 Nov; two weeks later the board still drew it 286 km out, with a progress
 * bar and an ETA, on a day the lorry was standing in the yard. A position that
 * old is a memory, and presenting it as a measurement is what made the yard
 * stop believing the board.
 */
describe('positionOf', () => {
  const NOW = Date.UTC(2026, 10, 20, 6, 0, 0);
  /** A fix 300 km north of the mill, aged as asked. */
  const fixAged = (minutes: number): Fix => ({
    latitude: 16.0,
    longitude: 78.5,
    speedKmph: 0,
    headingDeg: null,
    address: null,
    providerStatus: 'Parked',
    recordedAt: new Date(NOW - minutes * 60_000),
  });

  it('reads a recent fix as a position', () => {
    const pos = positionOf(fixAged(5), null, new Date(NOW), NOW);
    expect(pos.tracked).toBe(true);
    expect(pos.positionIsStale).toBe(false);
    expect(pos.distanceKm).toBeGreaterThan(100);
    expect(pos.etaAt).not.toBeNull();
  });

  it('still trusts a fix from an overnight halt', () => {
    // Four hours is a night stop, not a dead tracker. Blanking the board every
    // morning would be its own kind of wrong.
    const pos = positionOf(fixAged(4 * 60), null, new Date(NOW), NOW);
    expect(pos.positionIsStale).toBe(false);
    expect(pos.distanceKm).toBeGreaterThan(100);
  });

  it('refuses to turn a stale fix into a distance', () => {
    const pos = positionOf(fixAged(15 * 24 * 60), null, new Date(NOW), NOW);
    expect(pos.positionIsStale).toBe(true);
    expect(pos.distanceKm).toBeNull();
    expect(pos.etaAt).toBeNull();
    // Still on the feed, just silent - which reads differently on screen from a
    // lorry we never had a fix for at all.
    expect(pos.tracked).toBe(true);
    expect(pos.ageMinutes).toBeGreaterThan(POSITION_MAX_AGE_MINUTES);
  });

  it('leaves a lorry with no fix at all untracked, not stale', () => {
    const pos = positionOf(undefined, null, new Date(NOW), NOW);
    expect(pos.tracked).toBe(false);
    expect(pos.positionIsStale).toBe(false);
    expect(pos.distanceKm).toBeNull();
  });

  it('gives a stale lorry no phase to hide behind', () => {
    // The practical consequence: without a distance it is BOOKED, so it can
    // neither fire a ring nor sit on the board claiming to be approaching.
    const pos = positionOf(fixAged(15 * 24 * 60), null, new Date(NOW), NOW);
    expect(phaseOf(pos.distanceKm, rings)).toBe('BOOKED');
  });
});
