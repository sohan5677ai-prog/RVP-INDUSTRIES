import sharp from 'sharp';

// At most one frame per camera; simultaneous viewers share the same conversion.
const previews = new Map<1 | 2, { original: Buffer; result: Promise<Buffer> }>();

export function getCameraPreview(cam: 1 | 2, original: Buffer): Promise<Buffer> {
  const cached = previews.get(cam);
  if (cached?.original === original) return cached.result;
  const result = sharp(original)
    .rotate()
    .resize({ width: 640, height: 480, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 60 })
    .toBuffer();
  previews.set(cam, { original, result });
  result.catch(() => {
    if (previews.get(cam)?.result === result) previews.delete(cam);
  });
  return result;
}
