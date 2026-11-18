/**
 * Expiring links to stored files (Phase 5, carried over from PHASE-6B M2).
 *
 * The point of these is that a link to a supplier's invoice stops working.
 * So the tests that matter are the ones that prove it cannot be made not to:
 * the expiry is signed, the name is signed, and neither can be edited.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mintFileUrl,
  verifyFileToken,
  objectNameFromStored,
  isValidObjectName,
  DEFAULT_FILE_TTL_SECONDS,
} from './fileAccessToken.js';

const NAME = 'a'.repeat(32) + '.pdf';
const OTHER = 'b'.repeat(32) + '.pdf';

beforeEach(() => {
  process.env.JWT_SECRET = 'test-secret-for-file-links';
});
afterEach(() => {
  delete process.env.PUBLIC_API_BASE_URL;
});

/** Pull exp and sig back out of a minted URL. */
function parts(url: string) {
  const q = new URLSearchParams(url.split('?')[1]);
  return { exp: q.get('exp')!, sig: q.get('sig')! };
}

describe('isValidObjectName', () => {
  it('accepts what uploadFileToStorage generates', () => {
    for (const ext of ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'gif']) {
      expect(isValidObjectName(`${'0'.repeat(32)}.${ext}`), ext).toBe(true);
    }
  });

  it('refuses anything that could be a path traversal', () => {
    // This value arrives from a URL path and is handed to storage.
    for (const bad of [
      '../../etc/passwd',
      `${'a'.repeat(32)}.pdf/../secret.pdf`,
      `/${'a'.repeat(32)}.pdf`,
      `${'a'.repeat(32)}.html`,
      `${'a'.repeat(32)}.svg`,
      `${'a'.repeat(31)}.pdf`,
      `${'A'.repeat(32)}.pdf`,
      '',
    ]) {
      expect(isValidObjectName(bad), bad).toBe(false);
    }
  });
});

describe('objectNameFromStored', () => {
  it('reads a bare object name, which is what new uploads will store', () => {
    expect(objectNameFromStored(NAME)).toBe(NAME);
  });

  it('reads the Supabase public URL every existing row holds', () => {
    expect(
      objectNameFromStored(`https://xyz.supabase.co/storage/v1/object/public/invoices/${NAME}`)
    ).toBe(NAME);
  });

  it('reads one of our own links, in case one is round-tripped', () => {
    expect(objectNameFromStored(`https://api.example.com/api/files/${NAME}?exp=1&sig=2`)).toBe(NAME);
  });

  it('leaves anything else alone rather than mangling it', () => {
    // An external link that happens to end in 32 hex characters is not ours.
    expect(objectNameFromStored(`https://evil.example.com/${NAME}`)).toBeNull();
    expect(objectNameFromStored('https://example.com/some/invoice.pdf')).toBeNull();
    expect(objectNameFromStored('data:application/pdf;base64,AAAA')).toBeNull();
    expect(objectNameFromStored(null)).toBeNull();
    expect(objectNameFromStored('   ')).toBeNull();
  });
});

describe('mintFileUrl', () => {
  it('points at our own API, not at storage', () => {
    process.env.PUBLIC_API_BASE_URL = 'https://api.example.com/api';
    const link = mintFileUrl(NAME)!;
    expect(link.url.startsWith(`https://api.example.com/api/files/${NAME}?`)).toBe(true);
    expect(link.url).not.toContain('supabase');
  });

  it('mints from a legacy public URL too, so callers need not know which they have', () => {
    const link = mintFileUrl(
      `https://xyz.supabase.co/storage/v1/object/public/invoices/${NAME}`
    )!;
    expect(link.url).toContain(`/files/${NAME}?`);
  });

  it('is null when there is nothing to mint', () => {
    expect(mintFileUrl(null)).toBeNull();
    expect(mintFileUrl('https://example.com/not-ours.pdf')).toBeNull();
  });

  it('expires, which is the whole reason this exists', () => {
    const now = 1_700_000_000_000;
    const link = mintFileUrl(NAME, 60, now)!;
    expect(link.expiresAt).toBe(now + 60_000);
    const { exp, sig } = parts(link.url);
    expect(verifyFileToken({ objectName: NAME, exp, sig, now })).toBe('ok');
    expect(verifyFileToken({ objectName: NAME, exp, sig, now: now + 61_000 })).toBe('expired');
  });

  it('defaults to a short life', () => {
    const now = 1_700_000_000_000;
    expect(mintFileUrl(NAME, undefined, now)!.expiresAt).toBe(
      now + DEFAULT_FILE_TTL_SECONDS * 1000
    );
  });
});

describe('verifyFileToken - the parts that must not be forgeable', () => {
  const now = 1_700_000_000_000;
  const link = () => mintFileUrl(NAME, 60, now)!;

  it('refuses a token minted for a different file', () => {
    // Signing the expiry alone would let one invoice's link open another's.
    const { exp, sig } = parts(link().url);
    expect(verifyFileToken({ objectName: OTHER, exp, sig, now })).toBe('bad-signature');
  });

  it('refuses an extended expiry', () => {
    // The signature covers exp, so editing it to buy another year fails.
    const { sig } = parts(link().url);
    const farFuture = String(Math.floor(now / 1000) + 365 * 24 * 3600);
    expect(verifyFileToken({ objectName: NAME, exp: farFuture, sig, now })).toBe('bad-signature');
  });

  it('refuses a token signed with a different secret', () => {
    const { exp, sig } = parts(link().url);
    process.env.JWT_SECRET = 'a-different-secret';
    expect(verifyFileToken({ objectName: NAME, exp, sig, now })).toBe('bad-signature');
  });

  it('refuses a malformed name, expiry or signature', () => {
    const { exp, sig } = parts(link().url);
    expect(verifyFileToken({ objectName: '../etc/passwd', exp, sig, now })).toBe('bad-name');
    expect(verifyFileToken({ objectName: NAME, exp: undefined, sig, now })).toBe('malformed');
    expect(verifyFileToken({ objectName: NAME, exp: 'soon', sig, now })).toBe('malformed');
    expect(verifyFileToken({ objectName: NAME, exp, sig: 'nope', now })).toBe('malformed');
    expect(verifyFileToken({ objectName: NAME, exp, sig: 'f'.repeat(64), now })).toBe(
      'bad-signature'
    );
  });

  it('checks the signature before the expiry', () => {
    // Otherwise a stale-but-unsigned guess would be told "expired", which
    // confirms the object name exists before any valid token was presented.
    const stale = String(Math.floor(now / 1000) - 10);
    expect(verifyFileToken({ objectName: NAME, exp: stale, sig: '0'.repeat(64), now })).toBe(
      'bad-signature'
    );
  });
});
