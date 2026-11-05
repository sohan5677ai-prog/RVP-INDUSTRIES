/**
 * Viewer-demand tracking for the cabin CCTV relay.
 *
 * `cctv-bridge.mjs` used to push a frame per camera every second, around the
 * clock, whether or not a single person had the Kata screen open. At 3 AM on a
 * Sunday that is still 86,400 uploads a camera a day, each one a base64 JSON
 * body this process parses, buffers and throws away - which is what has been
 * pushing the service into its memory limit and restarting it.
 *
 * Inbound traffic is not billed, so this is not about the bandwidth invoice.
 * It is about not doing the work at all when nobody is looking.
 *
 * The server cannot call the bridge - the bridge sits behind the mill's router
 * and dials out. So the instruction rides back on the response to each
 * broadcast: "someone is watching, keep sending every second" or "nobody is,
 * slow down". The idle rate is deliberately a slow trickle rather than a full
 * stop, because that trickle is the only channel by which the bridge can learn
 * that someone has started watching again.
 *
 * What counts as a viewer:
 *   - a snapshot or stream request (someone pulling cloud frames)
 *   - an ANPR capture
 *   - a `/cctv/status` poll, which the Weighbridge screen sends every 5s
 *
 * That last one matters since the LAN-bridge change: a cabin PC now pulls its
 * frames from `127.0.0.1` and never touches this server for them, so snapshot
 * requests alone would make an actively-watched camera look idle. The status
 * poll deliberately still goes to the cloud, so it is our reliable "a Kata
 * screen is open somewhere" heartbeat - and it keeps the relay warm for the
 * auto-ANPR that fires when a lorry settles on the scale.
 */

/** How long a viewer's interest keeps the relay at full rate. */
export const VIEWER_TTL_MS = Number(process.env.CCTV_VIEWER_TTL_MS || 20_000);
/** Upload interval while someone is watching. Matches the previous constant rate. */
export const ACTIVE_INTERVAL_MS = Number(process.env.CCTV_ACTIVE_INTERVAL_MS || 1_000);
/** Upload interval when nobody is. Also the worst case for noticing a new viewer. */
export const IDLE_INTERVAL_MS = Number(process.env.CCTV_IDLE_INTERVAL_MS || 5_000);

const lastInterestAt: Record<1 | 2, number> = { 1: 0, 2: 0 };

/** Record that something asked to see this camera. */
export function markViewerInterest(cam: 1 | 2, now = Date.now()): void {
  lastInterestAt[cam] = now;
}

/** Record interest in both cameras - used by the status poll, which covers the pair. */
export function markAllViewerInterest(now = Date.now()): void {
  markViewerInterest(1, now);
  markViewerInterest(2, now);
}

export function isRelayWanted(cam: 1 | 2, now = Date.now()): boolean {
  const last = lastInterestAt[cam];
  return last > 0 && now - last < VIEWER_TTL_MS;
}

export interface RelayDirective {
  /** Whether a viewer has asked for this camera recently. */
  wanted: boolean;
  /** How long the bridge should wait before its next upload for this camera. */
  intervalMs: number;
  /** Milliseconds since the last viewer, or null if there has never been one. */
  idleForMs: number | null;
}

/**
 * What the bridge should do next for this camera.
 *
 * Returned on every broadcast response. A bridge that predates this, or one
 * that cannot parse the response, simply keeps its configured interval - the
 * directive is advisory, never required.
 */
export function getRelayDirective(cam: 1 | 2, now = Date.now()): RelayDirective {
  const last = lastInterestAt[cam];
  const wanted = isRelayWanted(cam, now);
  return {
    wanted,
    intervalMs: wanted ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS,
    idleForMs: last > 0 ? now - last : null,
  };
}

/** Test seam. */
export function resetRelayDemand(): void {
  lastInterestAt[1] = 0;
  lastInterestAt[2] = 0;
}
