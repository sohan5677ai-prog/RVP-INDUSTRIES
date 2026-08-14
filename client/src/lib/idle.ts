/**
 * Idle sign-out. Keep IDLE_TIMEOUT_MS in step with the server's copy in
 * server/src/lib/sessionPolicy.ts - the server rejects a session that has gone
 * quiet for longer, so a laxer client clock would just produce 401s.
 */
export const IDLE_TIMEOUT_MS = 20 * 60 * 1000;

/** How often we re-check the idle clock. */
const CHECK_INTERVAL_MS = 15 * 1000;

/** Don't POST a heartbeat more often than this while someone is working. */
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

/** Shared across tabs so activity in one keeps the others alive. */
const ACTIVITY_KEY = 'rvp_last_activity';

const ACTIVITY_EVENTS = [
  'mousedown',
  'mousemove',
  'keydown',
  'wheel',
  'scroll',
  'touchstart',
  'click',
] as const;

function readLastActivity(): number {
  const raw = localStorage.getItem(ACTIVITY_KEY);
  const ts = raw ? Number(raw) : NaN;
  return Number.isFinite(ts) ? ts : 0;
}

export function markActivity() {
  localStorage.setItem(ACTIVITY_KEY, String(Date.now()));
}

/**
 * Sign the user out once the app has gone untouched for IDLE_TIMEOUT_MS, and
 * keep the server session warm in the meantime. Returns a teardown function.
 */
export function startIdleWatch(opts: {
  onIdle: () => void;
  heartbeat: () => void;
}): () => void {
  markActivity();
  let lastHeartbeat = Date.now();
  let stopped = false;

  // Throttle: activity fires constantly, a localStorage write per mousemove is
  // needless churn.
  let lastWrite = 0;
  const onActivity = () => {
    const now = Date.now();
    if (now - lastWrite < 1000) return;
    lastWrite = now;
    markActivity();
  };

  for (const evt of ACTIVITY_EVENTS) {
    window.addEventListener(evt, onActivity, { passive: true });
  }
  const onVisible = () => {
    if (document.visibilityState === 'visible') onActivity();
  };
  document.addEventListener('visibilitychange', onVisible);

  const timer = window.setInterval(() => {
    if (stopped) return;
    const now = Date.now();
    const idleFor = now - readLastActivity();

    if (idleFor >= IDLE_TIMEOUT_MS) {
      stopped = true;
      opts.onIdle();
      return;
    }
    if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
      lastHeartbeat = now;
      opts.heartbeat();
    }
  }, CHECK_INTERVAL_MS);

  return () => {
    stopped = true;
    window.clearInterval(timer);
    for (const evt of ACTIVITY_EVENTS) window.removeEventListener(evt, onActivity);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
