/* -------------------------------------------------------------------------- */
/* Authorised-signature artwork                                               */
/*                                                                            */
/* Two transparent PNGs live in client/public and are re-used by every printed */
/* document that carries a signature - the tax invoice, the lorry receipt, the */
/* purchase verification statement and the party ledger.                       */
/*                                                                            */
/* The server keeps its own copy under server/src/assets for the PDFKit-drawn  */
/* documents; `npm run sync:signature` copies these two files across so the    */
/* printed and the downloaded version of a document never drift apart.         */
/* -------------------------------------------------------------------------- */

export const SIGNATURE_SRC = '/authorised-sign.png';
export const STAMP_SRC = '/company-stamp.png';

/** Absolute URLs - needed by documents rendered into a blob: window, where a
 *  root-relative path has no origin to resolve against. */
export const signatureUrl = () => new URL(SIGNATURE_SRC, window.location.origin).href;
export const stampUrl = () => new URL(STAMP_SRC, window.location.origin).href;

export interface SignatureBlockOptions {
  /** Rendered as "for <companyName>" above the mark. Omit to drop the line. */
  companyName?: string | null;
  /** Line under the mark. Pass null to drop it. */
  caption?: string | null;
  /** Rendered height of the ink, in px. */
  signHeight?: number;
  /** Rendered height of the round seal, in px. */
  stampSize?: number;
}

/**
 * The signature block as a raw HTML string, for documents built by string
 * concatenation rather than React (the party statement).
 */
export function signatureBlockHtml({
  companyName,
  caption = 'Authorised Signatory',
  signHeight = 55,
  stampSize = 95,
}: SignatureBlockOptions = {}): string {
  const boxH = Math.max(signHeight, stampSize);
  return `
  <div class="sig-block">
    ${companyName ? `<div class="sig-for">for ${companyName}</div>` : ''}
    <div class="sig-mark" style="height:${boxH}px">
      <img class="sig-stamp" src="${stampUrl()}" alt="" style="height:${stampSize}px">
      <img class="sig-ink" src="${signatureUrl()}" alt="" style="height:${signHeight}px">
    </div>
    ${caption ? `<div class="sig-caption">${caption}</div>` : ''}
  </div>`;
}

/** Styles for `signatureBlockHtml`. Inline once into the document's <style>. */
export const SIGNATURE_BLOCK_CSS = `
.sig-block { text-align: right; }
.sig-for { font-weight: 700; }
.sig-mark { position: relative; display: block; }
.sig-mark img {
  position: absolute;
  bottom: 0;
  width: auto;
  object-fit: contain;
  mix-blend-mode: multiply;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.sig-stamp { right: 0; opacity: .88; }
.sig-ink   { right: 14px; bottom: 8px; }
.sig-caption { border-top: 1px solid #cbd5e1; padding-top: 2px; }
`;
