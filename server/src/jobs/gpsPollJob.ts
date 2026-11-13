import { logger } from '../lib/logger.js';
import { locanixConfig, pollLocanix } from '../services/locanix.service.js';

/**
 * The GPS poll loop.
 *
 * A plain interval rather than node-cron, because the cadence here is seconds
 * and is read from configuration - `cron.schedule` would mean building a
 * six-field expression for what is simply "every N seconds". `pollLocanix`
 * never throws and refuses to overlap itself, so the timer needs no guard of
 * its own.
 *
 * Render spins a free instance down when idle. That is acceptable: the trail
 * has a hole for the time the service was asleep, and the next position after
 * it wakes is still the live one. If the holes start mattering, the fix is an
 * external cron hitting POST /api/gps/poll, not a paid instance.
 */
let timer: NodeJS.Timeout | null = null;

export function registerGpsPollCron(): void {
  const cfg = locanixConfig();

  if (!cfg.configured) {
    logger.info('[locanix] no LOCANIX_API_KEY - GPS polling is off');
    return;
  }
  if (!cfg.enabled) {
    logger.info('[locanix] LOCANIX_POLL_ENABLED=false - GPS polling is off');
    return;
  }
  if (timer) return;

  logger.info(`[locanix] polling every ${cfg.pollSeconds}s`);
  // A first pull straight away, so a restart does not leave the board blank
  // for a minute, but delayed a little to stay out of the way of boot.
  setTimeout(() => void pollLocanix(), 5_000).unref?.();
  timer = setInterval(() => void pollLocanix(), cfg.pollSeconds * 1000);
  timer.unref?.();
}

export function stopGpsPollCron(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
