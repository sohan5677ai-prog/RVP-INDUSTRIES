import { describe, it, expect } from 'vitest';
import { parseBookingReply, parseBookingReplies } from './bookingReply.js';

/**
 * The three messages of 19 Nov 2026 that went to the model and came back
 * inconsistently - one filed, two dropped. All three are the shape this ERP
 * asks for, so all three must now read the same way, every time.
 */
describe('parseBookingReply', () => {
  it('reads the shape the ERP asks transporters for', () => {
    const r = parseBookingReply('18NOV-01\nGJ18BV1872\n+919772764986\n35MT\nSAHADA');
    expect(r).toEqual({
      isTransportConfirmation: true,
      lorryNumber: 'GJ18BV1872',
      driverPhone: '9772764986',
      tonnageKg: 35000,
      fromPlace: 'SAHADA',
    });
  });

  it('tolerates a one-digit sequence and a spaced tonnage', () => {
    const r = parseBookingReply('19NOV-2\nGJ18BV5101\n+918490062825\n35 MT \nSAHADA');
    expect(r?.lorryNumber).toBe('GJ18BV5101');
    expect(r?.driverPhone).toBe('8490062825');
    expect(r?.tonnageKg).toBe(35000);
  });

  it('reads a bare 10-digit mobile', () => {
    const r = parseBookingReply('20NOV-03\nGJ18BW7540\n7378146792\n35MT\nAHMEDNAGAR');
    expect(r?.driverPhone).toBe('7378146792');
    expect(r?.fromPlace).toBe('AHMEDNAGAR');
  });

  it('skips the body type without losing the place', () => {
    const r = parseBookingReply('20NOV-03\nAP 39 T 8217\n9050306685\n30 Tonnes\n14W\nShahada');
    expect(r?.lorryNumber).toBe('AP39T8217');
    expect(r?.fromPlace).toBe('Shahada');
    expect(r?.tonnageKg).toBe(30000);
  });

  it('leaves sentence-style broker messages to the model', () => {
    expect(
      parseBookingReply('16/11/26 - Punganur to Shahada - 35 Tones - GJ18BV5741 - Driver Robin 9050306685 - Frieght - 80000'),
    ).toBeNull();
  });

  it('refuses a message whose first line is not a requirement code', () => {
    expect(parseBookingReply('Lorry booked\nGJ18BV1872\n9772764986\n35MT')).toBeNull();
  });

  it('does not turn a freight figure into a driver phone', () => {
    const r = parseBookingReply('18NOV-01\nGJ18BV1872\n35MT\n80000');
    expect(r?.driverPhone).toBeUndefined();
    expect(r?.lorryNumber).toBe('GJ18BV1872');
  });

  it('files nothing when neither a lorry nor a driver can be read', () => {
    expect(parseBookingReply('18NOV-01\n35MT\nSAHADA')).toBeNull();
  });
});

/**
 * A day's indent lists the whole fleet, so a transporter answers for several
 * codes in one message. Reading only the first lorry would lose the rest of the
 * day's vehicles, and nothing on screen would say so.
 */
describe('parseBookingReplies', () => {
  const threeLorries = [
    '20NOV-01', 'GJ18BV1872', '9772764986', '35MT', 'AUSA',
    '20NOV-02', 'GJ18BW7540', '7378146792', '35MT', 'SURAT',
    '20NOV-03', 'AP39T8217', '9050306685', '35MT', 'BARSHI',
  ].join('\n');

  it('reads every lorry, against its own code', () => {
    const blocks = parseBookingReplies(threeLorries);
    expect(blocks.map((b) => b.code)).toEqual(['20NOV-01', '20NOV-02', '20NOV-03']);
    expect(blocks.map((b) => b.parsed.lorryNumber)).toEqual([
      'GJ18BV1872', 'GJ18BW7540', 'AP39T8217',
    ]);
    expect(blocks[1].parsed.driverPhone).toBe('7378146792');
  });

  it('keeps the readable lorries when one block is mangled', () => {
    // A three-lorry message with one unreadable entry must still book the other
    // two rather than being thrown away whole.
    const text = [
      '20NOV-01', 'GJ18BV1872', '9772764986', '35MT',
      '20NOV-02', '35MT', 'SURAT',
      '20NOV-03', 'AP39T8217', '9050306685',
    ].join('\n');
    expect(parseBookingReplies(text).map((b) => b.code)).toEqual(['20NOV-01', '20NOV-03']);
  });

  it('still reads a single-lorry reply', () => {
    const blocks = parseBookingReplies(
      ['18NOV-01', 'GJ18BV1872', '+919772764986', '35MT', 'SAHADA'].join('\n'),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].code).toBe('18NOV-01');
    expect(blocks[0].parsed.tonnageKg).toBe(35000);
  });

  it('answers nothing when the first line is not a code', () => {
    const text = ['Sir lorry ready', '20NOV-01', 'GJ18BV1872', '9772764986'].join('\n');
    expect(parseBookingReplies(text)).toEqual([]);
  });

  it('is not answered by parseBookingReply, which files a single row', () => {
    // The single-row caller must not take the first of three and drop two.
    expect(parseBookingReply(threeLorries)).toBeNull();
  });
});
