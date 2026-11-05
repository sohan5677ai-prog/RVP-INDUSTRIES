import { beforeEach, describe, expect, it } from 'vitest';
import {
  ACTIVE_INTERVAL_MS,
  IDLE_INTERVAL_MS,
  VIEWER_TTL_MS,
  getRelayDirective,
  isRelayWanted,
  markAllViewerInterest,
  markViewerInterest,
  resetRelayDemand,
} from './cctvRelayDemand.js';

describe('CCTV relay viewer demand', () => {
  beforeEach(() => resetRelayDemand());

  it('idles until somebody actually asks for a camera', () => {
    const now = 1_000_000;
    expect(isRelayWanted(1, now)).toBe(false);
    const directive = getRelayDirective(1, now);
    expect(directive.wanted).toBe(false);
    expect(directive.intervalMs).toBe(IDLE_INTERVAL_MS);
    // Never watched at all, as opposed to watched a long time ago.
    expect(directive.idleForMs).toBeNull();
  });

  it('runs at full rate while a viewer is active', () => {
    const now = 1_000_000;
    markViewerInterest(1, now);
    const directive = getRelayDirective(1, now + 1_000);
    expect(directive.wanted).toBe(true);
    expect(directive.intervalMs).toBe(ACTIVE_INTERVAL_MS);
  });

  it('falls back to the trickle once interest goes stale', () => {
    const now = 1_000_000;
    markViewerInterest(1, now);
    expect(getRelayDirective(1, now + VIEWER_TTL_MS - 1).wanted).toBe(true);
    const stale = getRelayDirective(1, now + VIEWER_TTL_MS + 1);
    expect(stale.wanted).toBe(false);
    expect(stale.intervalMs).toBe(IDLE_INTERVAL_MS);
    expect(stale.idleForMs).toBe(VIEWER_TTL_MS + 1);
  });

  it('tracks the two cameras apart', () => {
    const now = 1_000_000;
    markViewerInterest(2, now);
    expect(getRelayDirective(1, now).wanted).toBe(false);
    expect(getRelayDirective(2, now).wanted).toBe(true);
  });

  it('keeps both cameras warm from a single status poll', () => {
    // The Weighbridge screen's 5s /cctv/status poll is the only demand signal
    // left once the cabin PC pulls its frames off the LAN bridge instead.
    const now = 1_000_000;
    markAllViewerInterest(now);
    expect(getRelayDirective(1, now).wanted).toBe(true);
    expect(getRelayDirective(2, now).wanted).toBe(true);
  });

  it('survives a screen left open: each poll renews the window', () => {
    let now = 1_000_000;
    markAllViewerInterest(now);
    // Five seconds between polls, well inside the TTL, so it never drops out.
    for (let i = 0; i < 20; i += 1) {
      now += 5_000;
      expect(isRelayWanted(1, now)).toBe(true);
      markAllViewerInterest(now);
    }
    // Screen closed - the relay winds down on its own.
    expect(isRelayWanted(1, now + VIEWER_TTL_MS + 1)).toBe(false);
  });

  it('idles far less often than it used to run', () => {
    // The point of the change: no viewer means a fraction of the uploads.
    expect(IDLE_INTERVAL_MS).toBeGreaterThan(ACTIVE_INTERVAL_MS);
    const perDayActive = 86_400_000 / ACTIVE_INTERVAL_MS;
    const perDayIdle = 86_400_000 / IDLE_INTERVAL_MS;
    expect(perDayIdle).toBeLessThanOrEqual(perDayActive / 2);
  });
});
