import { forwardRef, useMemo, useRef, useState } from 'react';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export type ComboOption = { value: string; label: string; hint?: string };

type ComboboxProps = {
  options: ComboOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  className?: string;
  contentClassName?: string;
  disabled?: boolean;
  ariaLabel?: string;
};

/** Searchable single-select - a glass trigger over a filterable, frosted list. */
export const Combobox = forwardRef<HTMLButtonElement, ComboboxProps>(function Combobox({
  options, value, onChange, placeholder = 'Select…', searchPlaceholder = 'Search…',
  emptyText = 'No matches.', className, contentClassName, disabled, ariaLabel,
}, ref) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = options.find((o) => o.value === value);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((o) => o.label.toLowerCase().includes(needle) || o.hint?.toLowerCase().includes(needle));
  }, [options, q]);

  function pick(v: string) {
    onChange(v);
    setOpen(false);
    setQ('');
  }

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQ(''); }} modal={true}>
      <PopoverTrigger asChild>
        <button
          ref={ref}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn(
            'glass-thin flex h-10 items-center justify-between gap-2 rounded-lg border border-input px-3 text-sm outline-none transition-[color,box-shadow,border-color] hover:border-ring/40 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:opacity-50',
            className
          )}
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>{selected ? selected.label : placeholder}</span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className={cn('w-[var(--radix-popover-trigger-width)] min-w-56 p-0 overflow-hidden', contentClassName)}
        onOpenAutoFocus={(e) => { e.preventDefault(); inputRef.current?.focus(); }}
      >
        <div className="flex items-center gap-2 border-b border-border/70 px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={searchPlaceholder}
            className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && filtered[0]) { e.preventDefault(); pick(filtered[0].value); }
            }}
          />
        </div>
        <div className="max-h-64 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">{emptyText}</div>
          ) : (
            filtered.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => pick(o.value)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
                  o.value === value ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-accent hover:text-accent-foreground'
                )}
              >
                <Check className={cn('h-4 w-4 shrink-0', o.value === value ? 'opacity-100' : 'opacity-0')} />
                <span className="flex-1 truncate">{o.label}</span>
                {o.hint && <span className="shrink-0 text-xs text-muted-foreground">{o.hint}</span>}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
});
