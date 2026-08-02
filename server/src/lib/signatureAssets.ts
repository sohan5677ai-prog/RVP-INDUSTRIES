import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* -------------------------------------------------------------------------- */
/* Authorised-signature artwork for the PDFKit-drawn documents                 */
/*                                                                            */
/* Master copies live in client/public (the browser-printed documents load     */
/* them by URL); `npm run sync:signature` mirrors them here so the downloaded  */
/* PDF and the printed page carry the same mark.                              */
/*                                                                            */
/* The path resolves to server/src/assets from both src/lib (tsx, dev) and     */
/* dist/lib (tsc output, Render), so the PNGs are never copied by the build.   */
/* -------------------------------------------------------------------------- */

const ASSET_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/assets');

let cache: { sign: Buffer | null; stamp: Buffer | null } | undefined;

function read(name: string): Buffer | null {
  try {
    return fs.readFileSync(path.join(ASSET_DIR, name));
  } catch {
    return null;
  }
}

/** Both PNGs, or nulls when the artwork has not been installed yet. */
export function signatureAssets(): { sign: Buffer | null; stamp: Buffer | null } {
  if (!cache) cache = { sign: read('authorised-sign.png'), stamp: read('company-stamp.png') };
  return cache;
}

/**
 * Pixel size straight out of the PNG's IHDR chunk - width and height are the
 * two big-endian uint32s at byte 16. PDFKit exposes `openImage` for this but
 * @types/pdfkit does not declare it, and the header is trivial to read.
 */
function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

export interface SignatureMarkOptions {
  /** Left edge of the column the mark is laid out in. */
  x: number;
  /** Width of that column. */
  width: number;
  /** Top of the mark. */
  y: number;
  signHeight?: number;
  stampSize?: number;
  align?: 'left' | 'center' | 'right';
}

/**
 * Draws the round seal with the scanned signature sitting over it, and returns
 * the y just below the mark. When the artwork is missing the space is still
 * reserved, so the layout does not shift and the copy can be signed by hand.
 */
export function drawSignatureMark(
  doc: PDFKit.PDFDocument,
  { x, width, y, signHeight = 45, stampSize = 75, align = 'right' }: SignatureMarkOptions,
): number {
  const boxH = Math.max(signHeight, stampSize);
  const { sign, stamp } = signatureAssets();

  /** Scaled width, and the x that puts the image on the aligned edge. */
  const place = (buf: Buffer, h: number, inset: number) => {
    const size = pngSize(buf);
    if (!size) return null;
    const w = (size.width / size.height) * h;
    const ax =
      align === 'left' ? x + inset : align === 'center' ? x + (width - w) / 2 : x + width - w - inset;
    return { ax, w };
  };

  if (stamp) {
    const p = place(stamp, stampSize, 0);
    if (p) doc.save().opacity(0.88).image(stamp, p.ax, y + boxH - stampSize, { width: p.w, height: stampSize }).restore();
  }
  if (sign) {
    // Offset inwards and up so the ink crosses the seal rather than sitting on it.
    const p = place(sign, signHeight, 8);
    if (p) doc.image(sign, p.ax, y + boxH - signHeight - 6, { width: p.w, height: signHeight });
  }

  return y + boxH;
}
