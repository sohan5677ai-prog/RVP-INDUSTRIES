import { cn } from '@/lib/utils';

/**
 * The official RVP Industries logo.
 *
 * The artwork is a light, stone-coloured wordmark, so it only reads properly
 * against a dark surface. `rvp-logo-dark.webp` is the same mark darkened for
 * light surfaces, and `tone="auto"` swaps between the two with the theme.
 *
 *   tone="light"  glyphs stay light  -> use on dark panels (login, sidebar)
 *   tone="dark"   glyphs are dark    -> use on white/paper surfaces, print
 *   tone="auto"   follows the theme  -> use on ordinary themed pages
 */

const LIGHT_SRC = '/rvp-logo.webp';
const DARK_SRC = '/rvp-logo-dark.webp';

type Tone = 'light' | 'dark' | 'auto';

export function BrandLogo({
  tone = 'light',
  className,
  alt = 'RVP Industries - Tamarind Seed Processing Unit',
}: {
  tone?: Tone;
  className?: string;
  alt?: string;
}) {
  if (tone === 'auto') {
    return (
      <>
        <img src={DARK_SRC} alt={alt} className={cn('block dark:hidden w-auto object-contain', className)} />
        <img src={LIGHT_SRC} alt="" aria-hidden className={cn('hidden dark:block w-auto object-contain', className)} />
      </>
    );
  }
  return (
    <img
      src={tone === 'dark' ? DARK_SRC : LIGHT_SRC}
      alt={alt}
      className={cn('block w-auto object-contain', className)}
    />
  );
}

/**
 * The square RVP monogram on its own mahogany plate - the compact stand-in for
 * the full wordmark in tight spots (sidebar header, avatars, tiles). It carries
 * its own background, so it sits on light and dark surfaces alike.
 */
export function BrandMark({ className, alt = 'RVP Industries' }: { className?: string; alt?: string }) {
  return (
    <img
      src="/rvp-icon-192.png"
      alt={alt}
      className={cn('block shrink-0 rounded-xl object-contain ring-1 ring-amber-300/20 shadow-lg shadow-amber-950/40', className)}
    />
  );
}

export default BrandLogo;
