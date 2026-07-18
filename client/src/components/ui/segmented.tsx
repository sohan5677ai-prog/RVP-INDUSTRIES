import { cn } from '@/lib/utils';

type Option<T extends string> = { label: string; value: T; count?: number };

type SegmentedProps<T extends string> = {
  options: Option<T>[];
  value: T;
  onValueChange: (v: T) => void;
  className?: string;
  size?: 'sm' | 'default';
};

/** Frosted pill segmented control - for status filters and view switches. */
export function Segmented<T extends string>({ options, value, onValueChange, className, size = 'default' }: SegmentedProps<T>) {
  return (
    <div className={cn('glass-thin inline-flex items-center gap-1 rounded-xl border border-border/70 p-1', className)}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onValueChange(o.value)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg font-semibold transition-colors duration-200',
              size === 'sm' ? 'px-2.5 py-1 text-[11px]' : 'px-3 py-1.5 text-xs',
              active
                ? 'bg-card text-foreground shadow-[var(--shadow-sm)] ring-1 ring-black/5'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {o.label}
            {o.count != null && (
              <span className={cn('rounded-full px-1.5 text-[10px] font-mono tabular-nums', active ? 'bg-primary/12 text-primary' : 'bg-muted text-muted-foreground')}>
                {o.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
