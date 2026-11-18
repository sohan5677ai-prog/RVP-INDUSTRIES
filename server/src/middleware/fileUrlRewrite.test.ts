/**
 * Handing out expiring links instead of public bucket URLs
 * (Phase 5, PHASE-6B M2, step two).
 *
 * The point is that no public storage URL reaches a caller any more. So the
 * tests check both halves: ours are replaced, and everything else is left
 * exactly as it was - because this walks every response the API sends, and
 * mangling an unrelated string would be a far worse bug than the one it fixes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { rewriteFileUrls } from './fileUrlRewrite.js';
import { objectNameFromStored } from '../lib/fileAccessToken.js';

const NAME = 'a'.repeat(32) + '.pdf';
const JPG = 'b'.repeat(32) + '.jpg';
const PUBLIC_URL = `https://xyz.supabase.co/storage/v1/object/public/invoices/${NAME}`;
const PUBLIC_JPG = `https://xyz.supabase.co/storage/v1/object/public/invoices/${JPG}`;

beforeEach(() => {
  process.env.JWT_SECRET = 'test-secret-for-file-links';
  process.env.PUBLIC_API_BASE_URL = 'https://api.example.com/api';
});

const minted = (v: unknown) => typeof v === 'string' && v.startsWith('https://api.example.com/api/files/');

describe('our stored files are replaced', () => {
  it('rewrites a public bucket URL into an expiring link', () => {
    const out = rewriteFileUrls({ invoiceFileUrl: PUBLIC_URL }) as any;
    expect(minted(out.invoiceFileUrl)).toBe(true);
    expect(out.invoiceFileUrl).toContain(NAME);
    expect(out.invoiceFileUrl).toContain('exp=');
    expect(out.invoiceFileUrl).toContain('sig=');
    // The whole point: the public URL does not reach the caller.
    expect(out.invoiceFileUrl).not.toContain('/object/public/');
  });

  it('works by value shape, so a column nobody listed is still covered', () => {
    // Twelve columns across eight models hold these today, and the next one
    // added should not need this file edited.
    const out = rewriteFileUrls({
      aFieldNobodyThoughtOf: PUBLIC_URL,
      nested: { deeper: { slipImageUrl: PUBLIC_JPG } },
    }) as any;
    expect(minted(out.aFieldNobodyThoughtOf)).toBe(true);
    expect(minted(out.nested.deeper.slipImageUrl)).toBe(true);
  });

  it('rewrites through arrays, which is how registers come back', () => {
    const out = rewriteFileUrls({
      rows: [{ kataFileUrl: PUBLIC_URL }, { kataFileUrl: PUBLIC_JPG }],
    }) as any;
    expect(out.rows.every((r: any) => minted(r.kataFileUrl))).toBe(true);
  });

  it('rewrites a bare object name, which is what new uploads may store', () => {
    expect(minted((rewriteFileUrls({ x: NAME }) as any).x)).toBe(true);
  });
});

describe('everything else is left exactly alone', () => {
  it('does not touch unrelated strings, numbers, nulls or dates', () => {
    const date = new Date('2026-11-18T00:00:00Z');
    const input = {
      party: 'KNM Agro',
      gstin: '37AACBS0915N1ZP',
      amount: 125000,
      nothing: null,
      when: date,
      external: 'https://example.com/some/invoice.pdf',
      lookalike: `https://evil.example.com/${NAME}`,
      shortHex: 'a'.repeat(32),
    };
    expect(rewriteFileUrls(input)).toBe(input);
  });

  it('returns the identical object when nothing changed', () => {
    // A 500-row register must not be rebuilt for no reason.
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: `r${i}`, amount: i }));
    const body = { rows, nextCursor: null };
    expect(rewriteFileUrls(body)).toBe(body);
    expect((rewriteFileUrls(body) as any).rows).toBe(rows);
  });

  it('leaves an already-minted link recognisable rather than corrupting it', () => {
    // It gets a fresh token, which is harmless; what matters is that the
    // object name survives so the link still resolves.
    const once = (rewriteFileUrls({ u: PUBLIC_URL }) as any).u;
    const twice = (rewriteFileUrls({ u: once }) as any).u;
    expect(objectNameFromStored(twice)).toBe(NAME);
  });
});

describe('it must not break the response it rewrites', () => {
  it('survives a cycle', () => {
    const a: Record<string, unknown> = { invoiceFileUrl: PUBLIC_URL };
    a.self = a;
    const out = rewriteFileUrls(a) as any;
    expect(minted(out.invoiceFileUrl)).toBe(true);
  });

  it('stops at a depth limit instead of walking forever', () => {
    let deep: Record<string, unknown> = { invoiceFileUrl: PUBLIC_URL };
    for (let i = 0; i < 40; i++) deep = { next: deep };
    expect(() => rewriteFileUrls(deep)).not.toThrow();
  });

  it('passes a scalar body straight through', () => {
    expect(rewriteFileUrls('OK')).toBe('OK');
    expect(rewriteFileUrls(null)).toBeNull();
    expect(rewriteFileUrls(42)).toBe(42);
  });
});
