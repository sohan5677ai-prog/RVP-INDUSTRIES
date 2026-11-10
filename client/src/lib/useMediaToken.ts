import { useEffect, useState } from 'react';
import {
  ensureMediaToken,
  peekMediaToken,
  subscribeMediaToken,
} from './mediaToken';

/**
 * Makes sure a media capability token exists and re-renders when it arrives.
 *
 * Any component that builds a camera `<img src>` or opens the scale
 * EventSource calls this, so the URL it builds carries `?k=` on the render
 * after the token lands. Returns the token, or null while there is none.
 */
export function useMediaToken(): string | null {
  const [token, setToken] = useState<string | null>(() => peekMediaToken());

  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeMediaToken((next) => {
      if (active) setToken(next);
    });
    ensureMediaToken().then((next) => {
      // ensureMediaToken resolves with the held token when one already exists,
      // in which case no event is published - so set it here too.
      if (active && next) setToken(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return token;
}
