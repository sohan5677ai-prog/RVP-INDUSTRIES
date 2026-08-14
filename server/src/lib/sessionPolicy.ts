/**
 * Session policy shared by login, the auth middleware and the client's idle
 * timer. Keep IDLE_TIMEOUT_MS in step with IDLE_TIMEOUT_MS in
 * client/src/lib/idle.ts — the browser signs itself out on that clock, the
 * server only uses it to decide when a session has gone quiet enough to stop
 * holding a device slot.
 */

/** No activity for this long and the browser signs the user out. */
export const IDLE_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Slack on top of the idle window before the server treats a session as dead.
 * Covers the gap between the client's last heartbeat and its own logout.
 */
export const SESSION_GRACE_MS = 90 * 1000;

/** How many devices one account may be signed in on at the same time. */
export const MAX_DEVICES_PER_USER = 2;

/** Don't rewrite lastSeenAt on every single request. */
export const LAST_SEEN_WRITE_INTERVAL_MS = 30 * 1000;

/**
 * Sentinel sid for tokens minted by internal services (the Slack bot) rather
 * than by a browser login. These carry no UserSession row, never count against
 * the device cap and never go idle.
 */
export const SERVICE_SESSION_ID = 'service';

/** Sessions last seen before this instant no longer count as live. */
export function liveSessionCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - IDLE_TIMEOUT_MS - SESSION_GRACE_MS);
}
