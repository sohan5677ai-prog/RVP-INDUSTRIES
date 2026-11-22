import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  /** Accent used when this segment is selected. */
  tone?: 'primary' | 'emerald' | 'amber' | 'rose' | 'slate';
}

const TONES: Record<NonNullable<SegmentOption<string>['tone']>, string> = {
  primary: 'bg-primary text-primary-foreground shadow-sm',
  emerald: 'bg-emerald-600 text-white shadow-sm',
  amber: 'bg-amber-500 text-stone-950 shadow-sm',
  rose: 'bg-rose-600 text-white shadow-sm',
  slate: 'bg-stone-700 text-white shadow-sm',
};

/**
 * Big, one-tap choice buttons. A weighbridge operator picks Loaded/Empty or
 * Cash/Credit/Free dozens of times a day; a searchable dropdown costs two or
 * three taps each time and hides the other options.
 */
export function SegmentedToggle<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  disabled,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'grid gap-1 rounded-xl border border-border bg-muted/50 p-1',
        disabled && 'pointer-events-none opacity-60',
      )}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(opt.value)}
            className={cn(
              'flex h-9 items-center justify-center gap-1.5 rounded-lg px-1.5 text-[11px] font-bold uppercase tracking-normal transition-colors',
              selected ? TONES[opt.tone ?? 'primary'] : 'text-muted-foreground hover:bg-background hover:text-foreground',
            )}
          >
            {opt.icon}
            <span className="truncate">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
