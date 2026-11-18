import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pngSize } from './signatureAssets.js';

/* -------------------------------------------------------------------------- */
/* The RVP Industries mark for the PDFKit-drawn documents                      */
/*                                                                            */
/* The master is client/public/rvp-logo-dark.png - the darkened cut of the     */
/* official logo, the one that reads on white paper - mirrored here by         */
/* `npm run sync:signature`. The browser-printed twins of these documents load */
/* the same artwork by URL (as .webp), so a party who gets the printed copy    */
/* from the office and the PDF on WhatsApp sees one letterhead, not two.       */
/*                                                                            */
/* The path resolves to server/src/assets from both src/lib (tsx, dev) and     */
/* dist/lib (tsc output, Render), so the build never has to copy the PNG.      */
/* -------------------------------------------------------------------------- */

const ASSET_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/assets');

let cache: { buf: Buffer | null } | undefined;

/** The logo PNG, or null when the artwork has not been synced yet. */
export function brandLogo(): Buffer | null {
  if (!cache) {
    try {
      cache = { buf: fs.readFileSync(path.join(ASSET_DIR, 'rvp-logo-dark.png')) };
    } catch {
      cache = { buf: null };
    }
  }
  return cache.buf;
}

export interface BrandLogoOptions {
  /** Left edge of the mark, or of the column it is aligned in. */
  x: number;
  /** Top of the mark. */
  y: number;
  /** Drawn height in points. */
  height?: number;
  /** Gap left below the mark; included in the returned y. */
  gap?: number;
  /** Column width - only needed for centre/right alignment. */
  width?: number;
  align?: 'left' | 'center' | 'right';
}

/**
 * Draws the logo and returns the y just below it (plus `gap`), so the caller
 * can carry on stacking the letterhead. When the artwork is missing it returns
 * `y` untouched, and the document simply prints without the mark rather than
 * leaving a hole in the header.
 */
export function drawBrandLogo(
  doc: PDFKit.PDFDocument,
  { x, y, height = 30, gap = 4, width = 0, align = 'left' }: BrandLogoOptions,
): number {
  const buf = brandLogo();
  if (!buf) return y;
  const size = pngSize(buf);
  if (!size) return y;

  const w = (size.width / size.height) * height;
  const ax = align === 'center' ? x + (width - w) / 2 : align === 'right' ? x + width - w : x;
  doc.image(buf, ax, y, { width: w, height });
  return y + height + gap;
}
