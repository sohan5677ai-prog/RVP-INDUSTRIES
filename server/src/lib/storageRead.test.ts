import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The regression this guards: the invoices bucket went private in Phase 5 but
 * every row still holds the `getPublicUrl` link, so server-side code that read
 * the column and fetched it got a 400 and rendered the Kata slip with two
 * empty camera boxes. readStoredFile must go to storage with the service role
 * instead of over HTTP.
 */
const download = vi.fn();
const from = vi.fn(() => ({ download }));

vi.mock('./supabase.js', () => ({
  getSupabase: () => ({ storage: { from } }),
  storageBucket: () => 'invoices',
}));
vi.mock('./logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const { readStoredFile, isStoredFile } = await import('./storageRead.js');

const NAME = 'a'.repeat(32) + '.jpg';
const PUBLIC_URL = `https://x.supabase.co/storage/v1/object/public/invoices/${NAME}`;

beforeEach(() => {
  download.mockReset();
  from.mockClear();
});

describe('isStoredFile', () => {
  it('recognises a legacy public bucket URL, a bare name and a signed /files link', () => {
    expect(isStoredFile(PUBLIC_URL)).toBe(true);
    expect(isStoredFile(NAME)).toBe(true);
    expect(isStoredFile(`https://rvp-server.onrender.com/api/files/${NAME}?exp=1&sig=2`)).toBe(true);
  });

  it('leaves anything else alone', () => {
    expect(isStoredFile(null)).toBe(false);
    expect(isStoredFile('data:image/jpeg;base64,AAAA')).toBe(false);
    expect(isStoredFile('/api/weighbridge/snapshots/ticket_12_cam1_99.jpg')).toBe(false);
    expect(isStoredFile('https://example.com/photo.jpg')).toBe(false);
  });
});

describe('readStoredFile', () => {
  it('downloads the object by name, not by the stored URL', async () => {
    download.mockResolvedValue({
      data: { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer },
      error: null,
    });

    const buf = await readStoredFile(PUBLIC_URL);

    expect(from).toHaveBeenCalledWith('invoices');
    expect(download).toHaveBeenCalledWith(NAME);
    expect(buf && [...buf]).toEqual([1, 2, 3]);
  });

  it('returns null - never throws - when the object is gone', async () => {
    download.mockResolvedValue({ data: null, error: { message: 'Object not found' } });
    await expect(readStoredFile(PUBLIC_URL)).resolves.toBeNull();
  });

  it('returns null when storage throws', async () => {
    download.mockRejectedValue(new Error('network down'));
    await expect(readStoredFile(PUBLIC_URL)).resolves.toBeNull();
  });

  it('does not touch storage for a value that is not ours', async () => {
    await expect(readStoredFile('https://example.com/photo.jpg')).resolves.toBeNull();
    expect(download).not.toHaveBeenCalled();
  });
});
