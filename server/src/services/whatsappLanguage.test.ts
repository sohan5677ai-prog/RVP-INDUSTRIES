import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The language fall-back is the safety property of the multilingual templates:
 * marking a party Tamil must never stop their message going out while the Tamil
 * copy is still in review. These pin that, and pin that the log records the
 * language actually SENT rather than the one asked for.
 */

vi.mock('../lib/prisma.js', () => ({ prisma: {} }));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { templateId, resolvedLanguage } = await import('./whatsapp.service.js');

const ENV_KEYS = [
  'FAST2SMS_TMPL_PO_CREATED',
  'FAST2SMS_TMPL_PO_CREATED_TA',
  'FAST2SMS_TMPL_PO_CREATED_TE',
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
    process.env.FAST2SMS_TMPL_PO_CREATED = '10000';
    process.env.FAST2SMS_TMPL_PO_CREATED_TA = '20000';
    expect(templateId('PO_CREATED', 'TA')).toBe('20000');
    expect(resolvedLanguage('PO_CREATED', 'TA')).toBe('TA');
  });

  it('falls back to English when the language copy is not approved yet', () => {
    process.env.FAST2SMS_TMPL_PO_CREATED = '10000';
    expect(templateId('PO_CREATED', 'TE')).toBe('10000');
    // ...and says so, so a log full of EN on a Telugu party is the missing id.
    expect(resolvedLanguage('PO_CREATED', 'TE')).toBe('EN');
  });

  it('does not let one language leak into another', () => {
    process.env.FAST2SMS_TMPL_PO_CREATED = '10000';
    process.env.FAST2SMS_TMPL_PO_CREATED_TA = '20000';
    expect(templateId('PO_CREATED', 'TE')).toBe('10000');
  });

  it('ignores a blank language override rather than sending on an empty id', () => {
    process.env.FAST2SMS_TMPL_PO_CREATED = '10000';
    process.env.FAST2SMS_TMPL_PO_CREATED_TA = '   ';
    expect(templateId('PO_CREATED', 'TA')).toBe('10000');
    expect(resolvedLanguage('PO_CREATED', 'TA')).toBe('EN');
  });

  it('stays undefined when neither copy exists - a clean SKIPPED, not a bad send', () => {
    expect(templateId('DISPATCH_DRIVER', 'KN')).toBeUndefined();
  });

  it('never reports a language for an EN recipient', () => {
    process.env.FAST2SMS_TMPL_PO_CREATED_TA = '20000';
    expect(resolvedLanguage('PO_CREATED', 'EN')).toBe('EN');
  });
});
