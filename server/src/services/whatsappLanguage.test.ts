import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The language fall-back is the safety property of the multilingual templates:
 * marking a party Tamil must never stop their message going out while the Tamil
 * copy is still in review. These pin that, and pin that the log records the
 * language actually SENT rather than the one asked for.
 *
 * The mechanism tests deliberately use a template with NO approved translations
 * (RECEIPT_RECEIVED today - STOCKIN_CONFIRMED held the role until its four
 * translations were approved on 2026-08-12) so they keep testing the fall-back
 * itself as more languages get approved. When RECEIPT_RECEIVED is translated in
 * turn, move these to the next untranslated key rather than deleting them - the
 * fall-back is the safety property, and it needs a template that exercises it.
 * Approved ids are pinned separately, by value.
 */

vi.mock('../lib/prisma.js', () => ({ prisma: {} }));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { templateId, resolvedLanguage, formatLorryPaymentText, formatLorryPaymentVariables } = await import('./whatsapp.service.js');

const ENV_KEYS = [
  'FAST2SMS_TMPL_RECEIPT_RECEIVED',
  'FAST2SMS_TMPL_RECEIPT_RECEIVED_TA',
  'FAST2SMS_TMPL_RECEIPT_RECEIVED_TE',
  'FAST2SMS_TMPL_STOCKIN_CONFIRMED',
  'FAST2SMS_TMPL_STOCKIN_CONFIRMED_TA',
  'FAST2SMS_TMPL_PO_CREATED',
  'FAST2SMS_TMPL_PO_CREATED_TA',
  'FAST2SMS_TMPL_LORRY_PAYMENT',
  'FAST2SMS_TMPL_LORRY_PAYMENT_TE',
  'FAST2SMS_TMPL_LORRY_PAYMENT_HI',
  'FAST2SMS_TMPL_LORRY_PAYMENT_TA',
  // Cleared so the "no id anywhere" case below reads the source, not a local .env.
  'FAST2SMS_TMPL_PAYMENT_SENT_TEXT',
  'FAST2SMS_TMPL_WISHES',
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('templateId language resolution', () => {
  it('uses the language copy when one is configured', () => {
    process.env.FAST2SMS_TMPL_RECEIPT_RECEIVED = '10000';
    process.env.FAST2SMS_TMPL_RECEIPT_RECEIVED_TA = '20000';
    expect(templateId('RECEIPT_RECEIVED', 'TA')).toBe('20000');
    expect(resolvedLanguage('RECEIPT_RECEIVED', 'TA')).toBe('TA');
  });

  it('falls back to English when the language copy is not approved yet', () => {
    process.env.FAST2SMS_TMPL_RECEIPT_RECEIVED = '10000';
    expect(templateId('RECEIPT_RECEIVED', 'TE')).toBe('10000');
    // ...and says so, so a log full of EN on a Telugu party is the missing id.
    expect(resolvedLanguage('RECEIPT_RECEIVED', 'TE')).toBe('EN');
  });

  it('does not let one language leak into another', () => {
    process.env.FAST2SMS_TMPL_RECEIPT_RECEIVED = '10000';
    process.env.FAST2SMS_TMPL_RECEIPT_RECEIVED_TA = '20000';
    expect(templateId('RECEIPT_RECEIVED', 'TE')).toBe('10000');
  });

  it('ignores a blank language override rather than sending on an empty id', () => {
    process.env.FAST2SMS_TMPL_RECEIPT_RECEIVED = '10000';
    process.env.FAST2SMS_TMPL_RECEIPT_RECEIVED_TA = '   ';
    expect(templateId('RECEIPT_RECEIVED', 'TA')).toBe('10000');
    expect(resolvedLanguage('RECEIPT_RECEIVED', 'TA')).toBe('EN');
  });

  it('stays undefined when neither copy exists - a clean SKIPPED, not a bad send', () => {
    // REMINDER has no checked-in id in any language: it lives on Render or is not yet approved.
    expect(templateId('REMINDER', 'KN')).toBeUndefined();
  });

  it('never reports a language for an EN recipient', () => {
    process.env.FAST2SMS_TMPL_RECEIPT_RECEIVED_TA = '20000';
    expect(resolvedLanguage('RECEIPT_RECEIVED', 'EN')).toBe('EN');
  });

  it('lets an env override beat the checked-in language id', () => {
    process.env.FAST2SMS_TMPL_PO_CREATED_TA = '99999';
    expect(templateId('PO_CREATED', 'TA')).toBe('99999');
  });
});

/**
 * The approved ids sit in one consecutive block, and a transposed pair does not
 * fail - it sends a Tamil supplier a valid, approved TELUGU message. Nothing in
 * the logs would show it. Hence pinning them by value.
 */
describe('approved language ids', () => {
  it('maps each PO language to its own approved message_id', () => {
    expect(templateId('PO_CREATED', 'TE')).toBe('28599');
    expect(templateId('PO_CREATED', 'TA')).toBe('28598');
    expect(templateId('PO_CREATED', 'KN')).toBe('28597');
    expect(templateId('PO_CREATED', 'HI')).toBe('28596');
  });

  it('maps each stock-in language to its own approved message_id', () => {
    expect(templateId('STOCKIN_CONFIRMED', 'TE')).toBe('28595');
    expect(templateId('STOCKIN_CONFIRMED', 'TA')).toBe('28594');
    expect(templateId('STOCKIN_CONFIRMED', 'KN')).toBe('28593');
    expect(templateId('STOCKIN_CONFIRMED', 'HI')).toBe('28592');
  });

  it('keeps the PO and stock-in blocks apart', () => {
    // Neighbouring five-digit blocks: 2859x is stock-in, 2859x is PO. Sending a
    // PO on a stock-in id is a valid, approved message about the wrong event.
    for (const lang of ['TE', 'TA', 'KN', 'HI'] as const) {
      expect(templateId('PO_CREATED', lang)).not.toBe(templateId('STOCKIN_CONFIRMED', lang));
    }
  });

  it('reports every translated language as itself, not as an English fall-back', () => {
    for (const lang of ['TE', 'TA', 'KN', 'HI'] as const) {
      expect(resolvedLanguage('PO_CREATED', lang)).toBe(lang);
      expect(resolvedLanguage('STOCKIN_CONFIRMED', lang)).toBe(lang);
    }
  });

  it('maps each private loan statement language to its own approved message_id', () => {
    expect(templateId('PRIVATE_LOAN_STATEMENT', 'EN')).toBe('28933');
    expect(templateId('PRIVATE_LOAN_STATEMENT', 'TE')).toBe('28935');
    expect(templateId('PRIVATE_LOAN_STATEMENT', 'HI')).toBe('28936');
    // TA and KN not drafted / approved yet, fall back to English
    expect(templateId('PRIVATE_LOAN_STATEMENT', 'TA')).toBe('28933');
    expect(templateId('PRIVATE_LOAN_STATEMENT', 'KN')).toBe('28933');
  });

  it('reports translated private loan statement languages as themselves, and unapproved as English fallback', () => {
    expect(resolvedLanguage('PRIVATE_LOAN_STATEMENT', 'EN')).toBe('EN');
    expect(resolvedLanguage('PRIVATE_LOAN_STATEMENT', 'TE')).toBe('TE');
    expect(resolvedLanguage('PRIVATE_LOAN_STATEMENT', 'HI')).toBe('HI');
    expect(resolvedLanguage('PRIVATE_LOAN_STATEMENT', 'TA')).toBe('EN');
    expect(resolvedLanguage('PRIVATE_LOAN_STATEMENT', 'KN')).toBe('EN');
  });

  it('maps WISHES to approved message_id 31089 and falls back to EN for other languages', () => {
    expect(templateId('WISHES', 'EN')).toBe('31089');
    expect(templateId('WISHES', 'TE')).toBe('31089');
    expect(templateId('WISHES', 'HI')).toBe('31089');
    expect(resolvedLanguage('WISHES', 'TE')).toBe('EN');
  });

  it('leaves a template with no translations falling back to English', () => {
    process.env.FAST2SMS_TMPL_RECEIPT_RECEIVED = '26130';
    expect(templateId('RECEIPT_RECEIVED', 'TA')).toBe('26130');
    expect(resolvedLanguage('RECEIPT_RECEIVED', 'TA')).toBe('EN');
  });

  it('formats lorry payment message text in all 4 languages (EN, TE, HI, TA)', () => {
    const sample = {
      date: new Date('2026-08-15T00:00:00.000Z'),
      lorryNumber: 'AP39TR1234',
      destination: 'Surat',
      grossFreight: 45000,
      kata: 250,
      hamali: 2000,
      otherDeductions: 3000,
      netPayable: 39750,
      amountPaid: 20000,
      reference: 'IMPS/12345',
      balance: 19750,
    };

    const enText = formatLorryPaymentText(sample, 'EN');
    expect(enText).toContain('LORRY FREIGHT PAYMENT RECEIPT');
    expect(enText).toContain('AP39TR1234');
    expect(enText).toContain('Surat');
    expect(enText).toContain('45,000');
    expect(enText).toContain('250');
    expect(enText).toContain('2,000');
    expect(enText).toContain('3,000');
    expect(enText).toContain('39,750');
    expect(enText).toContain('20,000');
    expect(enText).toContain('19,750');

    const teText = formatLorryPaymentText(sample, 'TE');
    expect(teText).toContain('లారీ రవాణా చెల్లింపు రశీదు');
    expect(teText).toContain('AP39TR1234');
    expect(teText).toContain('Surat');
    expect(teText).toContain('45,000');

    const hiText = formatLorryPaymentText(sample, 'HI');
    expect(hiText).toContain('लॉरी भाड़ा भुगतान रसीद');
    expect(hiText).toContain('AP39TR1234');
    expect(hiText).toContain('Surat');

    const taText = formatLorryPaymentText(sample, 'TA');
    expect(taText).toContain('லாரி வாடகை கட்டண ரசீது');
    expect(taText).toContain('AP39TR1234');
    expect(taText).toContain('Surat');

    const vars = formatLorryPaymentVariables(sample);
    expect(vars).toHaveLength(10);
    expect(vars[0]).toBe('15-Aug-2026');
    expect(vars[1]).toBe('AP39TR1234');
    expect(vars[2]).toBe('Surat');
    expect(vars[3]).toBe('45,000');
    expect(vars[4]).toBe('250');
    expect(vars[5]).toBe('2,000');
    expect(vars[6]).toBe('3,000');
    expect(vars[7]).toBe('39,750');
    expect(vars[8]).toBe('20,000');
    expect(vars[9]).toBe('19,750');
  });

  it('maps each lorry payment language to its own approved message_id', () => {
    expect(templateId('LORRY_PAYMENT', 'EN')).toBe('31369');
    expect(templateId('LORRY_PAYMENT', 'TE')).toBe('31377');
    expect(templateId('LORRY_PAYMENT', 'HI')).toBe('31378');
    expect(templateId('LORRY_PAYMENT', 'TA')).toBe('31379');
    // KN not created yet, falls back to English (31369)
    expect(templateId('LORRY_PAYMENT', 'KN')).toBe('31369');
  });

  it('reports translated lorry payment languages as themselves, and unapproved as English fallback', () => {
    expect(resolvedLanguage('LORRY_PAYMENT', 'EN')).toBe('EN');
    expect(resolvedLanguage('LORRY_PAYMENT', 'TE')).toBe('TE');
    expect(resolvedLanguage('LORRY_PAYMENT', 'HI')).toBe('HI');
    expect(resolvedLanguage('LORRY_PAYMENT', 'TA')).toBe('TA');
    expect(resolvedLanguage('LORRY_PAYMENT', 'KN')).toBe('EN');
  });

  it('supports LORRY_PAYMENT environment variable configuration and fallback', () => {
    process.env.FAST2SMS_TMPL_LORRY_PAYMENT = '40001';
    process.env.FAST2SMS_TMPL_LORRY_PAYMENT_TE = '40002';
    process.env.FAST2SMS_TMPL_LORRY_PAYMENT_HI = '40003';
    expect(templateId('LORRY_PAYMENT', 'EN')).toBe('40001');
    expect(templateId('LORRY_PAYMENT', 'TE')).toBe('40002');
    expect(templateId('LORRY_PAYMENT', 'HI')).toBe('40003');
    // KN has no language copy, falls back to the English env override (40001)
    expect(templateId('LORRY_PAYMENT', 'KN')).toBe('40001');
    expect(resolvedLanguage('LORRY_PAYMENT', 'TE')).toBe('TE');
    expect(resolvedLanguage('LORRY_PAYMENT', 'HI')).toBe('HI');
    expect(resolvedLanguage('LORRY_PAYMENT', 'KN')).toBe('EN');
  });
});
