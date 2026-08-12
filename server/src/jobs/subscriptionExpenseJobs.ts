import cron from 'node-cron';
import { logger } from '../lib/logger.js';
import { ensureSubscriptionCharges } from '../services/subscriptionExpense.service.js';

/**
 * Daily sweep that posts any subscription fee that has come due (Expenses →
 * Subscription). Runs at 00:15 IST so a charge dated the 1st or the 24th is on
 * the books first thing that morning.
 *
 * The generator is idempotent and cursor-driven, so this is only ever a
 * convenience: opening the Subscription tab runs the same catch-up, which is what
 * actually covers the case where Render has spun the server down overnight and
 * this timer never fired.
 */
export function registerSubscriptionCron() {
  cron.schedule(
    '15 0 * * *',
    () => {
      ensureSubscriptionCharges()
        .then((n) => {
          if (n > 0) logger.info(`[subscription] generated ${n} charge(s)`);
        })
        .catch((err) => logger.error('[subscription] daily sweep failed:', err));
    },
    { timezone: 'Asia/Kolkata' },
  );

  // Catch up once on boot too - covers a server that was down on a charge date
  // and only came back up later in the day.
  ensureSubscriptionCharges()
    .then((n) => {
      if (n > 0) logger.info(`[subscription] generated ${n} charge(s) on boot`);
    })
    .catch((err) => logger.error('[subscription] boot catch-up failed:', err));
}
