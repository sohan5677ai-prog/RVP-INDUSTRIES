import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { getCameraPreview } from './cctvPreview.js';

describe('CCTV bandwidth previews', () => {
  it('bounds preview dimensions without changing the source photo', async () => {
    const original = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#667788' } }).jpeg().toBuffer();
    const before = Buffer.from(original);
    const preview = await getCameraPreview(1, original);
    const metadata = await sharp(preview).metadata();
    expect(metadata.width).toBe(640);
    expect(metadata.height).toBe(360);
    expect(preview.length).toBeLessThan(original.length);
    expect(original.equals(before)).toBe(true);
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
