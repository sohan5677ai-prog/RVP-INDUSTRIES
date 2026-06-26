import * as React from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';

type SearchInputProps = Omit<React.ComponentProps<'input'>, 'onChange' | 'value'> & {
  value: string;
  onValueChange: (v: string) => void;
  containerClassName?: string;
};

/** Premium search field — leading icon, clear button, frosted glass. */
export function SearchInput({
  value, onValueChange, placeholder = 'Search…', className, containerClassName, ...props
}: SearchInputProps) {
  return (
    <div className={cn('group relative flex items-center', containerClassName)}>
      <Search className="pointer-events-none absolute left-3 h-4 w-4 text-muted-foreground transition-colors group-focus-within:text-primary" />
      <input
        type="text"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          'glass-thin h-10 w-full rounded-lg border border-input pl-9 pr-9 text-sm transition-[color,box-shadow,border-color] outline-none placeholder:text-muted-foreground hover:border-ring/40 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30',
          className
        )}
        {...props}
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onValueChange('')}
          className="absolute right-2 flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
