/**
 * Content sniffing for uploads.
 *
 * The upload filter used to trust `path.extname(file.originalname)`, which is
 * a string the client chooses. Renaming `payload.html` to `invoice.pdf` got it
 * past the check and into Supabase Storage, where objects are served from a
 * public bucket — so a stored HTML or SVG file would run as a page on that
 * origin, and the capability URL could be handed to anyone.
 *
 * So the bytes get the final say. Every format accepted here has a fixed
 * signature in its first few bytes; nothing is inferred from the filename or
 * from the client-supplied Content-Type.
 */

export type SniffedType = 'pdf' | 'jpeg' | 'png' | 'webp' | 'gif';

/** Canonical extension and media type for each format we accept. */
export const SNIFFED_TYPE_META: Record<SniffedType, { ext: string; mime: string }> = {
  pdf: { ext: '.pdf', mime: 'application/pdf' },
  jpeg: { ext: '.jpg', mime: 'image/jpeg' },
  png: { ext: '.png', mime: 'image/png' },
  webp: { ext: '.webp', mime: 'image/webp' },
  gif: { ext: '.gif', mime: 'image/gif' },
};

function startsWith(buf: Buffer, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buf[offset + i] !== bytes[i]) return false;
  }
  return true;
}

/**
 * Identify a buffer by its signature, or null if it is not a format we accept.
 *
 * Deliberately strict: a JPEG must start with FFD8FF, not merely contain it,
 * so a polyglot file with an HTML prologue and a JPEG further in is rejected.
 */
export function sniffFileType(buf: Buffer): SniffedType | null {
  // %PDF-
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf';
  // JPEG SOI + first marker
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'jpeg';
  // \x89PNG\r\n\x1a\n
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  // GIF87a / GIF89a
  if (
    startsWith(buf, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith(buf, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return 'gif';
  }
  // RIFF....WEBP — the size field sits between the two tags.
  if (
    startsWith(buf, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return 'webp';
  }
  return null;
}

/** How many bytes sniffFileType needs. */
export const SNIFF_BYTES = 12;
