import { PDFDocument } from 'pdf-lib';

/**
 * Concatenate several PDF buffers into a single PDF (pages kept in order).
 * pdfkit can't append existing PDFs, so we use pdf-lib to copy every page from
 * each source into one output document. Used to attach the Tax Invoice + E-Way
 * Bill as a single WhatsApp document (a template message allows only one file).
 */
export async function mergePdfs(buffers: Buffer[]): Promise<Buffer> {
  const nonEmpty = buffers.filter((b) => b && b.length > 0);
  if (nonEmpty.length === 1) return nonEmpty[0];
  const merged = await PDFDocument.create();
  for (const buf of nonEmpty) {
    const src = await PDFDocument.load(buf);
    const pages = await merged.copyPages(src, src.getPageIndices());
    pages.forEach((p) => merged.addPage(p));
  }
  const out = await merged.save();
  return Buffer.from(out);
}
