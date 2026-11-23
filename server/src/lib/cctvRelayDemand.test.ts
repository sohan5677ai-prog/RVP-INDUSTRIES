import { beforeEach, describe, expect, it } from 'vitest';
import {
  ACTIVE_INTERVAL_MS,
  BRIDGE_ALIVE_MS,
  IDLE_INTERVAL_MS,
  LORRY_ON_SCALE_KG,
  LORRY_TAIL_MS,
  PARKED_MS,
  VIEWER_TTL_MS,
  getRelayDirective,
  isBridgeAlive,
  isRelayWanted,
  markBridgeSeen,
  markViewerInterest,
  noteScaleOffline,
  noteScaleWeight,
  resetRelayDemand,
} from './cctvRelayDemand.js';

describe('CCTV relay demand', () => {
  beforeEach(() => resetRelayDemand());

  it('stays off with no lorry and nobody watching', () => {
    const now = 1_000_000;
    const directive = getRelayDirective(1, now);
    expect(directive.wanted).toBe(false);
    expect(directive.reason).toBeNull();
    expect(directive.intervalMs).toBe(IDLE_INTERVAL_MS);
    expect(directive.idleForMs).toBeNull();
  });

  it('ignores an empty scale drifting a few kilos', () => {
    const now = 1_000_000;
    noteScaleWeight(0, now);
    noteScaleWeight(40, now + 1_000);
    noteScaleWeight(LORRY_ON_SCALE_KG - 1, now + 2_000);
    expect(isRelayWanted(1, now + 2_000)).toBe(false);
  });

  it('turns both cameras on when a lorry drives onto the scale', () => {
    const now = 1_000_000;
    noteScaleWeight(0, now);
    noteScaleWeight(18_500, now + 1_000);
    for (const cam of [1, 2] as const) {
      const d = getRelayDirective(cam, now + 2_000);
      expect(d.wanted).toBe(true);
      expect(d.reason).toBe('WEIGHING');
      expect(d.intervalMs).toBe(ACTIVE_INTERVAL_MS);
    }
  });

  it('keeps them on for a tail after the lorry drives off, then stops', () => {
    const now = 1_000_000;
    noteScaleWeight(18_500, now);
    noteScaleWeight(0, now + 60_000);
    expect(isRelayWanted(1, now + 60_000 + LORRY_TAIL_MS - 1)).toBe(true);
    expect(isRelayWanted(1, now + 60_000 + LORRY_TAIL_MS + 1)).toBe(false);
  });

  it('stops for a lorry parked on the scale, and restarts when the weight moves', () => {
    const now = 1_000_000;
    noteScaleWeight(18_500, now);
    // Same weight reported over and over: not movement.
    noteScaleWeight(18_505, now + PARKED_MS / 2);
    expect(isRelayWanted(1, now + PARKED_MS - 1)).toBe(true);
    expect(isRelayWanted(1, now + PARKED_MS + 1)).toBe(false);
    // Loading starts again.
    noteScaleWeight(19_200, now + PARKED_MS + 5_000);
    expect(isRelayWanted(1, now + PARKED_MS + 6_000)).toBe(true);
  });

  it('treats a scale that goes offline as the lorry leaving', () => {
    const now = 1_000_000;
    noteScaleWeight(18_500, now);
    noteScaleOffline(now + 10_000);
    expect(isRelayWanted(1, now + 10_000 + LORRY_TAIL_MS + 1)).toBe(false);
  });

  it('turns one camera on for a remote viewer, and lets it lapse', () => {
    const now = 1_000_000;
    markViewerInterest(2, now);
    expect(getRelayDirective(1, now).wanted).toBe(false);
    const d = getRelayDirective(2, now + 1_000);
    expect(d.wanted).toBe(true);
    expect(d.reason).toBe('VIEWER');
    expect(isRelayWanted(2, now + VIEWER_TTL_MS + 1)).toBe(false);
  });

  it('knows the bridge is alive from its demand checks', () => {
    const now = 1_000_000;
    expect(isBridgeAlive(now)).toBe(false);
    markBridgeSeen(now);
    expect(isBridgeAlive(now + BRIDGE_ALIVE_MS - 1)).toBe(true);
    expect(isBridgeAlive(now + BRIDGE_ALIVE_MS + 1)).toBe(false);
  });
});
