import winston from 'winston';
import { scrub, scrubText, isSensitiveKey, REDACTED } from './logScrubber.js';

/**
 * Scrub every log record before it is formatted (Phase 5, plan item 6).
 *
 * Placed first in the chain so nothing downstream can serialise a value this
 * has not seen.
 *
 * It mutates `info`'s own keys but assigns *copies* into them, so the objects
 * the caller passed in are left alone - logging a party must not quietly
 * rewrite the party. Winston carries `level` and `message` on symbol keys as
 * well as string ones, and those symbols are what the transports read, so the
 * info object is edited in place rather than rebuilt: returning a fresh object
 * would drop them and every line would lose its level.
 */
const scrubSensitive = winston.format((info) => {
  if (typeof info.message === 'string') {
    info.message = scrubText(info.message);
  } else if (info.message !== undefined) {
    info.message = scrub(info.message) as typeof info.message;
  }

  if (typeof info.stack === 'string') info.stack = scrubText(info.stack);

  // The key has to be checked here as well as inside scrub(). Metadata lands
  // directly on `info`, and scrub() only sees the keys of objects it walks
  // into - so a top-level `{ password }` was reaching the log untouched, while
  // `{ bankAccountNumber }` was saved only by coincidence, its value happening
  // to look like a long digit run.
  for (const key of Object.keys(info)) {
    if (key === 'message' || key === 'level' || key === 'stack' || key === 'timestamp') continue;
    info[key] = isSensitiveKey(key) ? REDACTED : scrub(info[key]);
  }

  return info;
});

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    // errors() first so an Error's stack is lifted onto info.stack, and then
    // scrubbed - a stack can carry a token in a URL or an argument.
    winston.format.errors({ stack: true }),
    scrubSensitive(),
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: process.env.NODE_ENV === 'production'
        ? winston.format.json()
        : winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          ),
    })
  ],
});
