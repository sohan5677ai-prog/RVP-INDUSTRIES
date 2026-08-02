import { signatureUrl, stampUrl } from '@/lib/signatureAssets';

interface AuthorisedSignatureProps {
  /** Rendered as "for <companyName>" above the mark. Omit to drop the line. */
  companyName?: string | null;
  /** Line under the mark. Pass null to drop it. */
  caption?: string | null;
  /** Rendered height of the ink, in px. */
  signHeight?: number;
  /** Rendered height of the round seal, in px. */
  stampSize?: number;
  align?: 'left' | 'center' | 'right';
  /** Hairline above the caption, matching the surrounding document. */
  captionRule?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Scanned signature over the company seal, for the signature panel of a printed
 * document. Both PNGs are transparent; `mix-blend-mode: multiply` keeps them
 * clean should either ever be re-scanned onto a white background.
 *
 * Styling is inline rather than Tailwind so the block survives being serialised
 * into a standalone print window.
 */
export default function AuthorisedSignature({
  companyName,
  caption = 'Authorised Signatory',
  signHeight = 34,
  stampSize = 62,
  align = 'right',
  captionRule = false,
  className,
  style,
}: AuthorisedSignatureProps) {
  const boxH = Math.max(signHeight, stampSize);
  // The mark hangs off the same edge the block is aligned to.
  const edge = align === 'left' ? { left: 0 } : align === 'center' ? { left: '50%', transform: 'translateX(-50%)' } : { right: 0 };
  const inkEdge =
    align === 'left' ? { left: 14 } : align === 'center' ? { left: '50%', transform: 'translateX(-50%)' } : { right: 14 };

  const imgBase: React.CSSProperties = {
    position: 'absolute',
    bottom: 0,
    width: 'auto',
    objectFit: 'contain',
    mixBlendMode: 'multiply',
    WebkitPrintColorAdjust: 'exact',
    printColorAdjust: 'exact',
  };

  return (
    <div className={className} style={{ textAlign: align, ...style }}>
      {companyName && <div style={{ fontWeight: 700 }}>for {companyName}</div>}
      <div style={{ position: 'relative', height: boxH }}>
        <img src={stampUrl()} alt="" style={{ ...imgBase, ...edge, height: stampSize, opacity: 0.88 }} />
        <img src={signatureUrl()} alt="" style={{ ...imgBase, ...inkEdge, bottom: 8, height: signHeight }} />
      </div>
      {caption && (
        <div style={captionRule ? { borderTop: '1px solid #cbd5e1', paddingTop: 2 } : undefined}>{caption}</div>
      )}
    </div>
  );
}
