/**
 * Keeping sensitive values out of the logs (Phase 5, plan item 6).
 *
 * The cases that matter are the two shapes this codebase actually logs today:
 * a whole `req.body` passed as metadata, and a `JSON.stringify(req.body)`
 * concatenated into the message string. The first is covered by key name, the
 * second only by pattern - so both are tested, and so is the boundary where
 * the pattern deliberately stops.
 */
import { describe, it, expect } from 'vitest';
import { scrub, scrubText, REDACTED } from './logScrubber.js';

describe('by key name - the mechanism', () => {
  it('redacts a credential wherever it sits in the tree', () => {
    const out = scrub({
      user: { name: 'Sohan', password: 'hunter2', mfaSecret: 'JBSWY3DP' },
      list: [{ refreshTokenHash: 'abc' }],
    }) as any;
    expect(out.user.password).toBe(REDACTED);
    expect(out.user.mfaSecret).toBe(REDACTED);
    expect(out.list[0].refreshTokenHash).toBe(REDACTED);
    expect(out.user.name).toBe('Sohan');
  });

  it('redacts banking and identity fields', () => {
    const out = scrub({
      bankAccountNumber: '50100234567890',
      bankIfsc: 'HDFC0001234',
      pan: 'ABCDE1234F',
      aadhaar: '123412341234',
    }) as any;
    for (const k of ['bankAccountNumber', 'bankIfsc', 'pan', 'aadhaar']) {
      expect(out[k], k).toBe(REDACTED);
    }
  });

  it('ignores case, underscores and hyphens in the key', () => {
    const out = scrub({
      Bank_Account_Number: '50100234567890',
      'x-api-key': 'k',
      Authorization: 'Bearer abc',
    }) as any;
    expect(Object.values(out).every((v) => v === REDACTED)).toBe(true);
  });

  it('leaves the fields needed to debug alone', () => {
    // A scrubber that makes real faults harder to diagnose gets switched off.
    const out = scrub({
      partyName: 'KNM Agro',
      gstin: '37AACBS0915N1ZP',
      phone: '9440216173',
      lorryNumber: 'AP39TC1234',
      amount: 125000,
    }) as any;
    expect(out).toEqual({
      partyName: 'KNM Agro',
      gstin: '37AACBS0915N1ZP',
      phone: '9440216173',
      lorryNumber: 'AP39TC1234',
      amount: 125000,
    });
  });
});

describe('by pattern - the backstop', () => {
  it('redacts a JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJhYmMxMjMiLCJyb2xlIjoiQURNSU4ifQ.c2lnbmF0dXJlX2hlcmU';
    expect(scrubText(`auth failed for ${jwt}`)).toBe(`auth failed for ${REDACTED}`);
  });

  it('redacts a bearer or basic header value', () => {
    expect(scrubText('Authorization: Bearer abc123def456')).toContain(REDACTED);
    expect(scrubText('Authorization: Basic c29oYW46cGFzcw==')).toContain(REDACTED);
  });

  it('redacts a password hash', () => {
    expect(scrubText('compare failed: $argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA')).toBe(
      `compare failed: ${REDACTED}`
    );
  });

  it('redacts a sensitive key=value pasted into the message', () => {
    // The WhatsApp controller does exactly this:
    // logger.warn(`... ${JSON.stringify(req.body).slice(0, 500)}`)
    const body = JSON.stringify({ partyId: 'p1', bankAccountNumber: '50100234567890' });
    const out = scrubText(`[whatsapp] bad payload: ${body}`);
    expect(out).not.toContain('50100234567890');
    expect(out).toContain('partyId');
  });

  it('redacts a PAN and a long digit run', () => {
    expect(scrubText('pan ABCDE1234F for party')).toBe(`pan ${REDACTED} for party`);
    expect(scrubText('credited to 50100234567890 today')).toBe(`credited to ${REDACTED} today`);
  });

  it('leaves a ten-digit mobile readable, which is the documented limit', () => {
    // Deliberate: phone numbers are in these logs constantly and are needed to
    // debug a WhatsApp send. The cost is that a 9- or 10-digit account number
    // in free text is not caught by the pattern - the key-name rule is what
    // covers it when it is a field.
    expect(scrubText('sent to 9440216173')).toBe('sent to 9440216173');
    expect(scrubText('lorry AP39TC1234 at gate')).toBe('lorry AP39TC1234 at gate');
  });

  it('leaves a GSTIN readable, since it is printed on every invoice anyway', () => {
    expect(scrubText('gstin 37AACBS0915N1ZP')).toBe('gstin 37AACBS0915N1ZP');
  });
});

describe('it must not break the thing it is wrapping', () => {
  it('never mutates what it was given', () => {
    // Logging a party must not quietly rewrite the party.
    const original = { password: 'hunter2', nested: { token: 'abc' } };
    scrub(original);
    expect(original.password).toBe('hunter2');
    expect(original.nested.token).toBe('abc');
  });

  it('survives a cycle instead of overflowing the stack', () => {
    // A logged request or Prisma object may well contain one, and a stack
    // overflow inside the logger would take down whatever it was reporting.
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(scrub(a)).toEqual({ name: 'a', self: '[circular]' });
  });

  it('stops at a depth limit rather than walking forever', () => {
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    expect(JSON.stringify(scrub(deep))).toContain('depth limit');
  });

  it('keeps an Error an Error, with its message and stack scrubbed', () => {
    const err = new Error('failed with token eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.sig_here');
    const out = scrub(err) as Error;
    expect(out).toBeInstanceOf(Error);
    expect(out.message).toContain(REDACTED);
    expect(out.message).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('passes scalars and dates straight through', () => {
    const d = new Date('2026-11-18T00:00:00Z');
    expect(scrub(42)).toBe(42);
    expect(scrub(true)).toBe(true);
    expect(scrub(null)).toBeNull();
    expect(scrub(undefined)).toBeUndefined();
    expect(scrub(d)).toBe(d);
  });

  it('summarises a buffer rather than printing it', () => {
    expect(scrub(Buffer.from('a kata slip jpeg'))).toBe('[buffer 16b]');
  });
});
