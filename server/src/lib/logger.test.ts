/**
 * The scrubber, wired into winston (Phase 5, plan item 6).
 *
 * logScrubber.test.ts covers what gets redacted. This covers the wiring, which
 * has its own hazard: winston carries `level` and `message` on *symbol* keys
 * as well as string ones, and the transports read the symbols. A format that
 * returns a fresh object silently drops them and every line loses its level -
 * the logs keep working, so nothing fails, they are just quietly wrong.
 *
 * So these assert on what a transport actually receives.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import winston from 'winston';
import Transport from 'winston-transport';
import { logger } from './logger.js';
import { REDACTED } from './logScrubber.js';

const captured: Record<string, unknown>[] = [];

class Capture extends Transport {
  log(info: Record<string, unknown>, next: () => void) {
    captured.push(info);
    next();
  }
}

logger.add(new Capture({ format: winston.format.json() }));

beforeEach(() => {
  captured.length = 0;
});

/** What the transport sees, including the symbol winston routes on. */
const last = () => captured[captured.length - 1];
const levelSymbol = () => last()[Symbol.for('level') as unknown as string];

describe('the format keeps winston working', () => {
  it('still carries the level, on the symbol the transports read', () => {
    logger.warn('plain message');
    expect(last().level).toContain('warn');
    expect(levelSymbol()).toBe('warn');
  });

  it('still carries the message and a timestamp', () => {
    logger.info('the mill is running');
    expect(last().message).toBe('the mill is running');
    expect(last().timestamp).toBeTruthy();
  });
});

describe('it scrubs what actually reaches the transport', () => {
  it('redacts a credential in the metadata object', () => {
    // The weighbridge controller does this: logger.warn('...', req.body)
    logger.warn('bad second weight', { ticketId: 't1', bankAccountNumber: '50100234567890' });
    const out = JSON.stringify(last());
    expect(out).not.toContain('50100234567890');
    expect(out).toContain('t1');
    expect(levelSymbol()).toBe('warn');
  });

  /**
   * This is the test that was missing, and its absence let a real hole ship.
   *
   * Metadata keys land directly on `info`, and `scrub` only inspects the keys
   * of objects it walks *into* - so the top level was never key-checked. The
   * suite passed anyway, because the one metadata case it had used
   * `bankAccountNumber: '50100234567890'`, and a 14-digit run is caught by the
   * free-text pattern. The key-name rule was doing nothing there.
   *
   * A short credential that matches no pattern is the only way to tell the two
   * mechanisms apart, which is why these values are what they are.
   */
  it('redacts a short credential by key name, where no pattern would catch it', () => {
    logger.warn('validation failed', { password: 'hunter2', mfaSecret: 'JBSWY3DP', user: 'sohan' });
    const out = JSON.stringify(last());
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('JBSWY3DP');
    expect(last().password).toBe(REDACTED);
    expect(last().mfaSecret).toBe(REDACTED);
    // Still useful afterwards: the line must say who and what.
    expect(out).toContain('sohan');
    expect(out).toContain('validation failed');
  });

  it('redacts a value concatenated into the message string', () => {
    // The WhatsApp controller does this, with JSON.stringify(req.body).
    logger.warn(`[whatsapp] bad payload: ${JSON.stringify({ pan: 'ABCDE1234F' })}`);
    expect(String(last().message)).not.toContain('ABCDE1234F');
    expect(String(last().message)).toContain(REDACTED);
  });

  it('redacts an Error stack while keeping it reportable', () => {
    const err = new Error('login failed for Bearer abcdef123456');
    logger.error('auth threw', err);
    const out = JSON.stringify(last());
    expect(out).not.toContain('abcdef123456');
    expect(out).toContain('auth threw');
  });

  it('leaves an ordinary operational line untouched', () => {
    logger.info('[locanix] 36/145 stored (3 on dispatch)');
    expect(last().message).toBe('[locanix] 36/145 stored (3 on dispatch)');
  });

  it('does not mutate the object the caller passed in', () => {
    const body = { password: 'hunter2' };
    logger.warn('validation failed', body);
    expect(body.password).toBe('hunter2');
  });
});
