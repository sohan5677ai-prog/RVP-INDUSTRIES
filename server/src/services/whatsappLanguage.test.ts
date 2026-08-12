import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The language fall-back is the safety property of the multilingual templates:
 * marking a party Tamil must never stop their message going out while the Tamil
 * copy is still in review. These pin that, and pin that the log records the
 * language actually SENT rather than the one asked for.
 *
 * The mechanism tests deliberately use a template with NO approved translations
 * (STOCKIN_CONFIRMED today) so they keep testing the fall-back itself as more
 * languages get approved. Approved ids are pinned separately, by value.
 */

vi.mock('../lib/prisma.js', () => ({ prisma: {} }));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { templateId, resolvedLanguage } = await import('./whatsapp.service.js');

const ENV_KEYS = [
  'FAST2SMS_TMPL_STOCKIN_CONFIRMED',
  'FAST2SMS_TMPL_STOCKIN_CONFIRMED_TA',
  'FAST2SMS_TMPL_STOCKIN_CONFIRMED_TE',
  'FAST2SMS_TMPL_PO_CREATED',
  'FAST2SMS_TMPL_PO_CREATED_TA',
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
    process.env.FAST2SMS_TMPL_STOCKIN_CONFIRMED = '10000';
    process.env.FAST2SMS_TMPL_STOCKIN_CONFIRMED_TA = '20000';
    expect(templateId('STOCKIN_CONFIRMED', 'TA')).toBe('20000');
    expect(resolvedLanguage('STOCKIN_CONFIRMED', 'TA')).toBe('TA');
  });

  it('falls back to English when the language copy is not approved yet', () => {
    process.env.FAST2SMS_TMPL_STOCKIN_CONFIRMED = '10000';
    expect(templateId('STOCKIN_CONFIRMED', 'TE')).toBe('10000');
    // ...and says so, so a log full of EN on a Telugu party is the missing id.
    expect(resolvedLanguage('STOCKIN_CONFIRMED', 'TE')).toBe('EN');
  });

  it('does not let one language leak into another', () => {
    process.env.FAST2SMS_TMPL_STOCKIN_CONFIRMED = '10000';
    process.env.FAST2SMS_TMPL_STOCKIN_CONFIRMED_TA = '20000';
    expect(templateId('STOCKIN_CONFIRMED', 'TE')).toBe('10000');
  });

  it('ignores a blank language override rather than sending on an empty id', () => {
    process.env.FAST2SMS_TMPL_STOCKIN_CONFIRMED = '10000';
    process.env.FAST2SMS_TMPL_STOCKIN_CONFIRMED_TA = '   ';
    expect(templateId('STOCKIN_CONFIRMED', 'TA')).toBe('10000');
    expect(resolvedLanguage('STOCKIN_CONFIRMED', 'TA')).toBe('EN');
  });

  it('stays undefined when neither copy exists - a clean SKIPPED, not a bad send', () => {
    expect(templateId('DISPATCH_DRIVER', 'KN')).toBeUndefined();
  });

  it('never reports a language for an EN recipient', () => {
    process.env.FAST2SMS_TMPL_STOCKIN_CONFIRMED_TA = '20000';
    expect(resolvedLanguage('STOCKIN_CONFIRMED', 'EN')).toBe('EN');
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

  it('reports every PO language as itself, not as an English fall-back', () => {
    for (const lang of ['TE', 'TA', 'KN', 'HI'] as const) {
      expect(resolvedLanguage('PO_CREATED', lang)).toBe(lang);
    }
  });

  it('leaves a template with no translations falling back to English', () => {
    process.env.FAST2SMS_TMPL_STOCKIN_CONFIRMED = '26130';
    expect(templateId('STOCKIN_CONFIRMED', 'TA')).toBe('26130');
    expect(resolvedLanguage('STOCKIN_CONFIRMED', 'TA')).toBe('EN');
  });
});
