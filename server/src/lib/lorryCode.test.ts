import { describe, it, expect } from 'vitest';
import { formatLorryCode, parseLorryCode } from './lorryCode.js';

describe('formatLorryCode', () => {
  it('writes the day and month in IST', () => {
    // 2026-11-16T20:00:00Z is already the 17th in IST (01:30 on the 17th).
    expect(formatLorryCode(new Date('2026-11-16T20:00:00Z'), 2)).toBe('17NOV-02');
    expect(formatLorryCode(new Date('2026-11-16T06:00:00Z'), 2)).toBe('16NOV-02');
  });

  it('pads both halves', () => {
    expect(formatLorryCode(new Date('2026-01-05T06:00:00Z'), 7)).toBe('05JAN-07');
  });
});

describe('parseLorryCode', () => {
  it('reads the code off the first line of a real booking message', () => {
    const msg = ['16NOV-02', 'GJ18BV5741', '9050306685', '35MT', 'CONTANOR', 'Sahada-MH'].join('\n');
    expect(parseLorryCode(msg)).toBe('16NOV-02');
  });

  it('normalises the spelling the transporter used', () => {
    expect(parseLorryCode('6 nov - 2\nGJ18BV5741')).toBe('06NOV-02');
    expect(parseLorryCode('  16NOV-2  \nGJ18BV5741')).toBe('16NOV-02');
  });

  it('reads a code the transporter annotated with the indent it answers', () => {
    // Pravin, 20 Nov: the code, then which indent it was, then the lorry.
    const msg = ['20NOV-01 30 Tons to Surat', 'GJ18BW7697', '9974458416', '35 MT'].join('\n');
    expect(parseLorryCode(msg)).toBe('20NOV-01');
    expect(parseLorryCode('18NOV-02 - Shahada')).toBe('18NOV-02');
    expect(parseLorryCode('18NOV-02 / GJ18BV1872 / 35MT')).toBe('18NOV-02');
  });

  it('will not let the sequence run on into another token', () => {
    expect(parseLorryCode('20NOV-012')).toBe('20NOV-12');
    expect(parseLorryCode('20NOV-01X')).toBeNull();
  });

  it('ignores a code buried mid-line', () => {
    // The rule given to the transporter is "the code on its own first line".
    // A loose scan reads lorry numbers, dates and "14W" as codes, and this
    // parse gates an outbound WhatsApp - so a near-miss must read as no code.
    expect(parseLorryCode('Lorry for 16NOV-02 is GJ18BV5741')).toBeNull();
  });

  it('is not fooled by the rest of a booking message', () => {
    const msg = ['GJ18BV5741', '9050306685', '35MT', 'CONTANOR', 'Sahada-MH'].join('\n');
    expect(parseLorryCode(msg)).toBeNull();
    expect(parseLorryCode('18/7/26 Punganur To Surat 30 Tones AP 39 T 8217')).toBeNull();
    expect(parseLorryCode('')).toBeNull();
    expect(parseLorryCode(null)).toBeNull();
  });

  it('only looks at the top of the message', () => {
    const msg = ['GJ18BV5741', '9050306685', '35MT', 'CONTANOR', 'Sahada-MH', '16NOV-02'].join('\n');
    expect(parseLorryCode(msg)).toBeNull();
  });

  it('rejects an impossible day or a zero sequence', () => {
    expect(parseLorryCode('40NOV-02')).toBeNull();
    expect(parseLorryCode('16NOV-00')).toBeNull();
  });
});
