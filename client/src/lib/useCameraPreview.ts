import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getScaleApiUrl } from './api';
import { useMediaToken } from './useMediaToken';
import {
  getLocalBridgeOrigin,
  probeLocalBridge,
  reportLocalBridgeFailure,
  subscribeLocalBridge,
} from './localBridge';

/**
 * Size of the frame we ask the server for.
 *
 * `sm` is the live grid thumbnail, `lg` the expanded full-view dialog. Only
 * matters on the cloud path - the local bridge serves whatever the camera gave
 * it, and costs nothing either way. Ticket capture and ANPR keep using the
 * untouched full-resolution snapshot endpoint.
 */
export type CameraPreviewVariant = 'sm' | 'lg';

/** Preview only: ticket capture continues to use the original snapshot endpoint. */
export function useCameraPreview(
  cam: 1 | 2 | null,
  enabled = true,
  refreshTrigger = 0,
  variant: CameraPreviewVariant = 'sm'
) {
  const [frameUrl, setFrameUrl] = useState<string>();
  const scheduleRef = useRef<(() => void) | null>(null);

  // The cloud snapshot endpoint needs a capability token in the URL, because an
  // <img> cannot send a header. Holding it here re-renders the hook once it
  // arrives, so the next frame URL carries it.
  const mediaToken = useMediaToken();

  // Re-render when the bridge appears or disappears so `getScaleApiUrl` starts
  // (or stops) handing back LAN URLs for the very next frame.
  const bridgeOrigin = useSyncExternalStore(
    subscribeLocalBridge,
    getLocalBridgeOrigin,
    () => null
  );

  // Look for a bridge on this machine as soon as a camera is on screen. Cheap,
  // cached, and at most one probe in flight however many camera boxes mount.
  useEffect(() => {
    if (cam === null || !enabled) return;
    void probeLocalBridge();
  }, [cam, enabled]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const active = () => !disposed && enabled && cam !== null && document.visibilityState === 'visible';
    const refresh = () => {
      if (active()) {
        setFrameUrl(
          getScaleApiUrl(
            `/weighbridge/cctv/snapshot?cam=${cam}&preview=${variant}&t=${Date.now()}`
          )
        );
      }
    };
    const schedule = () => {
      clearTimeout(timer);
      if (active()) timer = setTimeout(refresh, 5000);
    };
    const visibilityChanged = () => {
      clearTimeout(timer);
      refresh();
    };
    scheduleRef.current = schedule;
    refresh();
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      disposed = true;
      clearTimeout(timer);
      scheduleRef.current = null;
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
    // `bridgeOrigin` is a dependency so switching between LAN and cloud takes
    // effect immediately rather than at the next five-second tick, and
    // `mediaToken` so the first frame after sign-in carries the token instead
    // of waiting five seconds to be retried.
  }, [cam, enabled, refreshTrigger, variant, bridgeOrigin, mediaToken]);

  const onFrameSettled = useCallback(() => scheduleRef.current?.(), []);

  /**
   * Call from the <img> error handler. If the frame came off the local bridge,
   * stop trusting it and fall back to the cloud so the operator is never left
   * looking at a dead camera box - the next probe will pick the bridge back up.
   */
  const onFrameError = useCallback(() => {
    if (getLocalBridgeOrigin()) {
      reportLocalBridgeFailure();
      void probeLocalBridge(true);
    }
  }, []);

  return { frameUrl, onFrameSettled, onFrameError, usingLocalBridge: bridgeOrigin !== null };
}
