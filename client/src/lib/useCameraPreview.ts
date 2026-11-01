import { useCallback, useEffect, useRef, useState } from 'react';
import { getScaleApiUrl } from './api';

/** Preview only: ticket capture continues to use the original snapshot endpoint. */
export function useCameraPreview(cam: 1 | 2 | null, enabled = true, refreshTrigger = 0) {
  const [frameUrl, setFrameUrl] = useState<string>();
  const scheduleRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const active = () => !disposed && enabled && cam !== null && document.visibilityState === 'visible';
    const refresh = () => {
      if (active()) {
        setFrameUrl(getScaleApiUrl(`/weighbridge/cctv/snapshot?cam=${cam}&preview=1&t=${Date.now()}`));
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
  }, [cam, enabled, refreshTrigger]);

  const onFrameSettled = useCallback(() => scheduleRef.current?.(), []);
  return { frameUrl, onFrameSettled };
}
