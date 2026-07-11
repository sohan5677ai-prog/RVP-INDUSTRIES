import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Sun/moon theme switch - guards against hydration flash before mount. */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const isDark = mounted && resolvedTheme === 'dark';

  return (
    <button
      type="button"
      aria-label="Toggle theme"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      className={cn(
        'inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-card/60 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
        className
      )}
    >
      <Sun className={cn('h-4 w-4 transition-all', isDark ? 'scale-0 -rotate-90 absolute' : 'scale-100 rotate-0')} />
      <Moon className={cn('h-4 w-4 transition-all', isDark ? 'scale-100 rotate-0' : 'scale-0 rotate-90 absolute')} />
    </button>
  );
}
