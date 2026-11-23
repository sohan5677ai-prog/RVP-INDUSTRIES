/**
 * When the cabin CCTV relay should be sending pictures to the cloud.
 *
 * Camera frames were the one thing this server handled every second of every
 * day: the bridge pushed a picture per camera every second while any Kata
 * screen was open (the status poll counted as "watching"), and every five
 * seconds when nothing was. Each one is parsed, buffered and thrown away, and
 * that steady churn is what kept pushing the instance into Render's 512 MB
 * limit.
 *
 * Now the relay is ON only when a picture is actually needed:
 *
 *   1. A lorry is on the weighbridge. The cabin screen posts every scale
 *      reading here, so the server sees the weight rise as a lorry drives on.
 *      The cameras run while the weight is moving, and for a short tail after
 *      the lorry drives off, which covers the ticket photo at Save. A lorry
 *      left parked on the scale stops the relay after PARKED_MS of a steady
 *      weight, and the next change in weight starts it again.
 *
 * That is the ONLY trigger. Opening a camera box (cloud snapshot/stream) used
 * to switch the relay on too, but any office PC or phone with a camera box
 * open - or a cabin browser that could not reach the LAN bridge and fell back
 * to the cloud - re-armed it every 5 s and kept pictures going up all day with
 * the scale empty. A remote viewer now sees the last picture from the last
 * weighing. Viewer requests are still counted (idleForMs) for diagnostics.
 *
 * Otherwise the bridge sends no pictures at all. It asks GET /cctv/demand every
 * few seconds instead - a few hundred bytes, no image - which is how it hears
 * that a lorry has arrived or a viewer has opened a camera.
 */

/** Upload interval while the relay is on. The camera boxes refresh every 5 s. */
export const ACTIVE_INTERVAL_MS = Number(process.env.CCTV_ACTIVE_INTERVAL_MS || 2_000);
/**
 * Upload interval an OLDER bridge is told to use while idle. A current bridge
 * sends nothing while idle and learns about demand from GET /cctv/demand; an
 * older one only hears back on an upload, so it still needs a slow trickle.
 */
export const IDLE_INTERVAL_MS = Number(process.env.CCTV_IDLE_INTERVAL_MS || 15_000);

/** A reading at or above this is a lorry on the platform, not drift on an empty scale. */
export const LORRY_ON_SCALE_KG = Number(process.env.CCTV_LORRY_ON_SCALE_KG || 300);
/** A change smaller than this is the indicator settling, not the load changing. */
export const WEIGHT_MOVEMENT_KG = Number(process.env.CCTV_WEIGHT_MOVEMENT_KG || 20);
/** Keep the cameras on this long after the lorry drives off - covers Save and the slip. */
export const LORRY_TAIL_MS = Number(process.env.CCTV_LORRY_TAIL_MS || 90_000);
/** A weight that has not moved for this long is a parked lorry: stop until it moves. */
export const PARKED_MS = Number(process.env.CCTV_PARKED_MS || 2 * 60_000);

const lastInterestAt: Record<1 | 2, number> = { 1: 0, 2: 0 };

const scale = {
  onScale: false,
  lastKg: 0,
  /** Last time the weight rose onto the scale or moved while a lorry was on it. */
  lastMovementAt: 0,
  /** Last time the weight dropped back off the scale. */
  leftAt: 0,
};

/** Record that a remote viewer asked to see this camera. Diagnostic only: it does not wake the relay. */
export function markViewerInterest(cam: 1 | 2, now = Date.now()): void {
  lastInterestAt[cam] = now;
}

/**
 * Feed every scale reading the cabin posts. Cheap: a few comparisons, called
 * at most a few times a second while the weight is changing.
 */
export function noteScaleWeight(kg: number, now = Date.now()): void {
  if (!Number.isFinite(kg)) return;
  if (kg >= LORRY_ON_SCALE_KG) {
    if (!scale.onScale || Math.abs(kg - scale.lastKg) >= WEIGHT_MOVEMENT_KG) {
      scale.lastMovementAt = now;
    }
    scale.onScale = true;
  } else if (scale.onScale) {
    scale.onScale = false;
    scale.leftAt = now;
  }
  scale.lastKg = kg;
}

/** The scale disconnected: no lorry can be inferred from it any more. */
export function noteScaleOffline(now = Date.now()): void {
  if (scale.onScale) {
    scale.onScale = false;
    scale.leftAt = now;
  }
}

/** Whether a lorry on (or just off) the weighbridge wants the cameras on. */
export function isWeighingActive(now = Date.now()): boolean {
  if (scale.onScale && scale.lastMovementAt > 0 && now - scale.lastMovementAt < PARKED_MS) return true;
  return scale.leftAt > 0 && now - scale.leftAt < LORRY_TAIL_MS;
}

export type RelayReason = 'WEIGHING' | null;

function reasonFor(_cam: 1 | 2, now: number): RelayReason {
  return isWeighingActive(now) ? 'WEIGHING' : null;
}

export function isRelayWanted(cam: 1 | 2, now = Date.now()): boolean {
  return reasonFor(cam, now) !== null;
}

export interface RelayDirective {
  /** Whether the bridge should be sending pictures for this camera. */
  wanted: boolean;
  /** Why: a lorry on the weighbridge. Null when idle. */
  reason: RelayReason;
  /** How long the bridge should wait before its next upload for this camera. */
  intervalMs: number;
  /** Milliseconds since the last remote viewer, or null if there has never been one. */
  idleForMs: number | null;
}

/**
 * What the bridge should do next for this camera. Returned by GET /cctv/demand
 * and on every broadcast response.
 */
export function getRelayDirective(cam: 1 | 2, now = Date.now()): RelayDirective {
  const last = lastInterestAt[cam];
  const reason = reasonFor(cam, now);
  return {
    wanted: reason !== null,
    reason,
    intervalMs: reason !== null ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS,
    idleForMs: last > 0 ? now - last : null,
  };
}

/**
 * The bridge checks in on GET /cctv/demand every few seconds, so that - not a
 * recent picture - is now the proof it is alive. An idle relay sends no
 * pictures, and must read as "standby", not as a dead camera.
 */
export const BRIDGE_ALIVE_MS = 20_000;
let bridgeSeenAt = 0;

export function markBridgeSeen(now = Date.now()): void {
  bridgeSeenAt = now;
}

export function isBridgeAlive(now = Date.now()): boolean {
  return bridgeSeenAt > 0 && now - bridgeSeenAt < BRIDGE_ALIVE_MS;
}

/** Test seam. */
export function resetRelayDemand(): void {
  bridgeSeenAt = 0;
  lastInterestAt[1] = 0;
  lastInterestAt[2] = 0;
  scale.onScale = false;
  scale.lastKg = 0;
  scale.lastMovementAt = 0;
  scale.leftAt = 0;
}
