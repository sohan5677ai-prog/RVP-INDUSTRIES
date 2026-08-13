const DEVICE_KEY = 'rvp_device_id';

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `dev-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * Stable id for this browser profile. The server caps an account at two live
 * device sessions, keyed on this value, so it has to survive reloads - but not
 * a cleared localStorage (a wiped browser simply looks like a new device).
 */
export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = randomId();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}
