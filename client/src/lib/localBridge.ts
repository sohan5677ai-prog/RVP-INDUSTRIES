/**
 * Local CCTV bridge discovery.
 *
 * The cameras, the cabin PC and the office PCs all sit on the same mill LAN,
 * but every camera frame used to make a round trip through Render in Oregon:
 * `cctv-bridge.mjs` POSTs frames up to the cloud, and each browser pulled them
 * back down again. Render bills outbound traffic at $0.15/GB, so a single
 * Weighbridge screen left open cost roughly 21 MB/hour - about 7.5 GB a month -
 * for pictures that never needed to leave the building.
 *
 * `cctv-bridge.mjs` already serves the identical snapshot/stream endpoints on
 * `http://127.0.0.1:4004`, straight from RAM. When that bridge answers we use
 * it and the cloud relay costs nothing at all.
 *
 * Why loopback works from an HTTPS page: browsers treat `127.0.0.1` as a
 * potentially trustworthy origin, so it is exempt from mixed-content blocking.
 * The bridge also replies with `Access-Control-Allow-Private-Network: true`,
 * which is what Chrome's Private Network Access preflight asks for.
 *
 * Only machines actually running the bridge benefit, which is the point: the
 * cabin PC is the screen that stays open all day, and it is the one burning
 * the bandwidth.
 */

const PROBE_TIMEOUT_MS = 1200;
/** Re-confirm a working bridge occasionally, in case it is stopped mid-shift. */
const RECHECK_OK_MS = 5 * 60_000;
/** Retry a missing bridge far less often, so off-site browsers aren't spamming. */
const RECHECK_MISSING_MS = 60_000;

const OVERRIDE_KEY = 'rvp_local_bridge';

type Listener = () => void;

const listeners = new Set<Listener>();

/** Resolved bridge origin, or null when we should use the cloud. */
let activeOrigin: string | null = null;
let lastProbeAt = 0;
let probeInFlight: Promise<void> | null = null;

/**
 * Where the bridge would be if it were running here.
 *
 * `localStorage.rvp_local_bridge` overrides it: set a full origin to point at a
 * bridge on another port, or the string `off` to force everything back through
 * the cloud (useful when diagnosing whether the bridge itself is at fault).
 */
function candidateOrigin(): string | null {
  if (typeof window === 'undefined') return null;

  let override: string | null = null;
  try {
    override = window.localStorage.getItem(OVERRIDE_KEY);
  } catch {
    // Private mode / blocked storage - fall through to the default.
  }
  if (override === 'off') return null;
  if (override) return override.replace(/\/+$/, '');

  const port = import.meta.env.VITE_LOCAL_BRIDGE_PORT ?? '4004';
  return `http://127.0.0.1:${port}`;
}

function setActiveOrigin(next: string | null) {
  if (activeOrigin === next) return;
  activeOrigin = next;
  for (const listener of listeners) listener();
}

/**
 * The bridge origin to use right now, or null while we have not found one.
 *
 * Synchronous on purpose: `getScaleApiUrl` is called during render. Before the
 * first probe resolves this returns null and we use the cloud, then the probe
 * flips it and subscribers re-render with local URLs.
 */
export function getLocalBridgeOrigin(): string | null {
  return activeOrigin;
}

/**
 * Check whether the local bridge is up, at most one probe at a time.
 *
 * Results are cached: a bridge we found is re-checked every 5 minutes, one we
 * did not find every minute. Pass `force` after a frame has failed to load.
 */
export function probeLocalBridge(force = false): Promise<void> {
  const candidate = candidateOrigin();
  if (!candidate) {
    setActiveOrigin(null);
    return Promise.resolve();
  }

  if (probeInFlight) return probeInFlight;

  if (!force && lastProbeAt) {
    const ttl = activeOrigin ? RECHECK_OK_MS : RECHECK_MISSING_MS;
    if (Date.now() - lastProbeAt < ttl) return Promise.resolve();
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  probeInFlight = fetch(`${candidate}/api/weighbridge/cctv/status`, {
    signal: controller.signal,
    cache: 'no-store',
  })
    .then((res) => {
      // A 404 means something else holds the port - treat only a real answer
      // from the bridge as success.
      setActiveOrigin(res.ok ? candidate : null);
    })
    .catch(() => {
      // Not running here, blocked, or timed out. The cloud path still works.
      setActiveOrigin(null);
    })
    .finally(() => {
      clearTimeout(timer);
      lastProbeAt = Date.now();
      probeInFlight = null;
    });

  return probeInFlight;
}

/**
 * Called when a frame served from the local bridge fails to load.
 *
 * Drops straight back to the cloud so the operator never stares at a dead
 * camera box, and re-probes so we return to local as soon as the bridge is back.
 */
export function reportLocalBridgeFailure(): void {
  if (!activeOrigin) return;
  setActiveOrigin(null);
  lastProbeAt = Date.now();
}

export function subscribeLocalBridge(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
