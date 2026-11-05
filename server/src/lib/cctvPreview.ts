import sharp from 'sharp';

/**
 * Downscaled JPEGs for the live camera boxes.
 *
 * These frames are the whole of our Render outbound bandwidth bill: they are
 * JPEGs, so neither gzip nor brotli touches them, and a Weighbridge screen left
 * open pulls two of them every five seconds all day.
 *
 * The previous bounds (640x480, `withoutEnlargement`) were a no-op in practice.
 * The bridge relays the camera sub-stream at 352x288, which is already inside
 * 640x480, so sharp passed the buffer through untouched - a frame fetched with
 * `preview=1` came back byte-for-byte identical to the full one, about 16 KB.
 *
 * `sm` now genuinely downscales for the grid thumbnails, where the operator is
 * watching for a lorry rather than reading a plate. `lg` backs the expanded
 * dialog: no downscale at this source size, but still re-encoded, since the
 * bridge's MJPEG frames are written at a far higher quality than a preview
 * needs.
 *
 * Ticket capture and ANPR never come through here - they read the untouched
 * full-resolution frame.
 */
const VARIANTS = {
  sm: { width: 320, height: 240, quality: 50 },
  lg: { width: 640, height: 480, quality: 65 },
} as const;

export type PreviewVariant = keyof typeof VARIANTS;

/** Cached per camera *and* variant, so the grid and the dialog don't evict each other. */
const previews = new Map<string, { original: Buffer; result: Promise<Buffer> }>();

export function getCameraPreview(
  cam: 1 | 2,
  original: Buffer,
  variant: PreviewVariant = 'sm'
): Promise<Buffer> {
  const key = `${cam}:${variant}`;
  const cached = previews.get(key);
  // Identity check, not a hash: the relay replaces the whole buffer each frame,
  // so the same object means the same frame and every viewer shares one encode.
  if (cached?.original === original) return cached.result;

  const { width, height, quality } = VARIANTS[variant];
  const result = sharp(original)
    .rotate()
    .resize({ width, height, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer()
    // A re-encode that somehow lands bigger than the source is pure loss -
    // ship the original instead.
    .then((out) => (out.length < original.length ? out : original));

  previews.set(key, { original, result });
  result.catch(() => {
    if (previews.get(key)?.result === result) previews.delete(key);
  });
  return result;
}
