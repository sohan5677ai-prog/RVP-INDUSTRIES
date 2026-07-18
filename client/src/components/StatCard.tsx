import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type Tone = 'amber' | 'forest' | 'clay' | 'gold' | 'rose' | 'taupe';

const tones: Record<Tone, { chip: string; line: string }> = {
  amber: { chip: 'bg-amber-500/12 text-amber-700 dark:text-amber-400', line: 'bg-amber-500/60' },
  forest: { chip: 'bg-emerald-700/12 text-emerald-800 dark:text-emerald-400', line: 'bg-emerald-700/60' },
  clay: { chip: 'bg-orange-600/12 text-orange-800 dark:text-orange-400', line: 'bg-orange-600/60' },
  gold: { chip: 'bg-yellow-600/12 text-yellow-800 dark:text-yellow-400', line: 'bg-yellow-600/60' },
  rose: { chip: 'bg-rose-600/12 text-rose-800 dark:text-rose-400', line: 'bg-rose-600/60' },
  taupe: { chip: 'bg-stone-500/12 text-stone-700 dark:text-stone-300', line: 'bg-stone-500/60' },
};

type StatCardProps = {
  label: string;
  value: ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  tone?: Tone;
  hint?: ReactNode;
  className?: string;
};

/** Glass KPI tile - content is clamped so figures never spill outside the tile. */
export function StatCard({ label, value, icon: Icon, tone = 'amber', hint, className }: StatCardProps) {
  const t = tones[tone];
  const valueStr = typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
  return (
    <div
      className={cn(
        'group glass relative flex min-w-0 flex-col overflow-hidden rounded-2xl p-4 sm:p-5 transition-[transform,box-shadow] duration-300 ease-out hover:-translate-y-1 hover:shadow-[var(--shadow-lg)] [container-type:inline-size]',
        className
      )}
    >
      {/* left accent rule */}
      <span className={cn('pointer-events-none absolute left-0 top-5 bottom-5 w-[3px] rounded-full', t.line)} />
      <div className="flex items-start justify-between gap-2 pl-2 min-w-0">
        <span className="min-w-0 truncate text-[10.5px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">{label}</span>
        {Icon && (
          <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-transform duration-300 group-hover:scale-105', t.chip)}>
            <Icon className="h-[18px] w-[18px]" />
          </div>
        )}
      </div>
      <div
        className="num-fit mt-2.5 pl-2 font-mono font-medium tracking-tight text-foreground leading-none"
        style={{ fontSize: 'clamp(0.9rem, 10.5cqi, 1.5rem)' }}
        title={valueStr}
      >
        {value}
      </div>
      {hint && <div className="mt-1.5 pl-2 truncate text-xs text-muted-foreground" title={typeof hint === 'string' ? hint : undefined}>{hint}</div>}
    </div>
  );
}
