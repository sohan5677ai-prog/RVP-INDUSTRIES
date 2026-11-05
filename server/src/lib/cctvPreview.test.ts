import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { getCameraPreview } from './cctvPreview.js';

describe('CCTV bandwidth previews', () => {
  it('bounds preview dimensions without changing the source photo', async () => {
    const original = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#667788' } }).jpeg().toBuffer();
    const before = Buffer.from(original);
    const preview = await getCameraPreview(1, original);
    const metadata = await sharp(preview).metadata();
    expect(metadata.width).toBe(320);
    expect(metadata.height).toBe(180);
    expect(preview.length).toBeLessThan(original.length);
    expect(original.equals(before)).toBe(true);
  });

  it('gives the expanded dialog a larger frame than the grid thumbnail', async () => {
    const original = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#445566' } }).jpeg().toBuffer();
    const large = await getCameraPreview(1, original, 'lg');
    expect((await sharp(large).metadata()).width).toBe(640);
  });

  it('caches per variant so the grid and the dialog do not evict each other', async () => {
    const original = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#223344' } }).jpeg().toBuffer();
    const small = getCameraPreview(2, original, 'sm');
    const large = getCameraPreview(2, original, 'lg');
    expect(getCameraPreview(2, original, 'sm')).toBe(small);
    expect(getCameraPreview(2, original, 'lg')).toBe(large);
    expect(small).not.toBe(large);
    await Promise.all([small, large]);
  });

  it('actually shrinks the 352x288 sub-stream frame the cabin relay sends', async () => {
    // The real regression: the old 640x480 bound left these frames untouched,
    // so `preview=1` shipped the same ~16 KB the full endpoint did.
    const original = await sharp({ create: { width: 352, height: 288, channels: 3, background: '#8899aa' } })
      .jpeg({ quality: 92 })
      .toBuffer();
    const preview = await getCameraPreview(1, original, 'sm');
    const metadata = await sharp(preview).metadata();
    expect(metadata.width).toBeLessThan(352);
    expect(preview.length).toBeLessThan(original.length);
  });

  it('does not enlarge small frames and shares conversion only for the same camera frame', async () => {
    const original = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#112233' } }).jpeg().toBuffer();
    const first = getCameraPreview(1, original);
    expect(getCameraPreview(1, original)).toBe(first);
    expect(getCameraPreview(2, original)).not.toBe(first);
    const preview = await first;
    expect((await sharp(preview).metadata()).width).toBe(320);
    const next = getCameraPreview(1, Buffer.from(original));
    expect(next).not.toBe(first);
    await next;
  });
});
