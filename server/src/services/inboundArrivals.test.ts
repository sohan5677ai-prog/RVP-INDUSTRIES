import { describe, it, expect } from 'vitest';
import { phaseOf, DEFAULT_APPROACH_RING_KM, DEFAULT_GATE_RING_KM, type ArrivalRings } from './inboundArrivals.service.js';

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
    expect(phaseOf(4, rings)).toBe('APPROACHING');
    expect(phaseOf(3, rings)).toBe('AT_GATE');
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
