import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Grounding tests for the lorry-booking reader.
 *
 * A model handed a message it cannot read does not say so - it answers with the
 * worked example from its own prompt. That is how the register filled with
 * "18 Jul 2026 / AP39T8217 / Driver Moula / Rs 80,000" rows that no transporter
 * ever sent. Every field is therefore checked back against the message before it
 * is believed.
 */

const generateContent = vi.fn();

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: (...a: unknown[]) => generateContent(...a) };
  },
  Type: { OBJECT: 'OBJECT', STRING: 'STRING', NUMBER: 'NUMBER', BOOLEAN: 'BOOLEAN', ARRAY: 'ARRAY' },
}));

const { parseTransportConfirmationText } = await import('./gemini.js');

/** Answer the next call with this object, as Gemini's JSON response. */
function reply(obj: unknown) {
  generateContent.mockResolvedValue({ text: JSON.stringify(obj) });
}

const REAL_MESSAGE =
  '16/11/26 - Punganur to Shahada - 35 Tones - GJ18BV5741 - Driver Robin 9050306685 - Frieght - 80000';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GEMINI_API_KEY = 'test-key';
});

describe('parseTransportConfirmationText', () => {
  it('keeps a reading that is actually written in the message', async () => {
    reply({
      isTransportConfirmation: true,
      lorryNumber: 'GJ 18 BV 5741',
      driverName: 'Robin',
      driverPhone: '9050306685',
      tonnageKg: 35000,
      freightAmount: 80000,
      freightBasis: 'TOTAL',
    });
    const out = await parseTransportConfirmationText(REAL_MESSAGE);
    expect(out).toMatchObject({
      isTransportConfirmation: true,
      lorryNumber: 'GJ18BV5741',
      driverName: 'Robin',
      driverPhone: '9050306685',
      freightAmount: 80000,
    });
  });

  it('throws away a lorry number that is nowhere in the message', async () => {
    // The exact failure seen in production: the prompt's own example came back
    // as the answer to a media link.
    reply({
      isTransportConfirmation: true,
      messageDate: '2026-07-18',
      fromPlace: 'Punganur',
      toPlace: 'Surat',
      tonnageKg: 30000,
      lorryNumber: 'AP39T8217',
      driverName: 'Moula',
      driverPhone: '7207012803',
      freightAmount: 80000,
    });
    const out = await parseTransportConfirmationText(
      'https://files.fast2sms.com/chat_uploads/2012326/1674492334027097.jpg'
    );
    expect(out).toBeNull();
  });

  it('drops a driver phone the message never carried', async () => {
    reply({
      isTransportConfirmation: true,
      lorryNumber: 'GJ18BV5741',
      driverName: 'Robin',
      driverPhone: '7207012803', // from the example, not from this message
      tonnageKg: 35000,
    });
    const out = await parseTransportConfirmationText(REAL_MESSAGE);
    expect(out?.lorryNumber).toBe('GJ18BV5741');
    expect(out?.driverPhone).toBeUndefined();
  });

  it('files the row dateless rather than at a year that never happened', async () => {
    // Stray digits elsewhere in a message read as a date years off. A booking is
    // news about a lorry loading now, so an implausible one is simply not a date.
    reply({
      isTransportConfirmation: true,
      lorryNumber: 'GJ18BV5741',
      messageDate: '2020-07-14',
      tonnageKg: 35000,
    });
    const out = await parseTransportConfirmationText(REAL_MESSAGE);
    expect(out?.messageDate).toBeUndefined();
    expect(out?.lorryNumber).toBe('GJ18BV5741');
  });

  it('says it is not a booking when nothing of the lorry survives', async () => {
    reply({ isTransportConfirmation: true, fromPlace: 'Punganur', toPlace: 'Surat' });
    const out = await parseTransportConfirmationText(REAL_MESSAGE);
    expect(out?.isTransportConfirmation).toBe(false);
  });
});
