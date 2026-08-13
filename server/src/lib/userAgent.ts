/**
 * Turn a raw User-Agent into something a person can recognise in a device list
 * ("Chrome on Windows"). Deliberately crude - it only has to be good enough for
 * someone to tell their own two devices apart.
 */
export function describeUserAgent(ua: string | null | undefined): string {
  if (!ua) return 'Unknown device';

  const browser =
    /\bEdg\//.test(ua) ? 'Edge'
    : /\bOPR\/|\bOpera\b/.test(ua) ? 'Opera'
    : /\bFirefox\//.test(ua) ? 'Firefox'
    : /\bChrome\//.test(ua) ? 'Chrome'
    : /\bSafari\//.test(ua) ? 'Safari'
    : null;

  const os =
    /\bAndroid\b/.test(ua) ? 'Android'
    : /\b(iPhone|iPad|iPod)\b/.test(ua) ? 'iOS'
    : /\bWindows\b/.test(ua) ? 'Windows'
    : /\bMac OS X\b/.test(ua) ? 'macOS'
    : /\bLinux\b/.test(ua) ? 'Linux'
    : null;

  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? 'Unknown device';
}
