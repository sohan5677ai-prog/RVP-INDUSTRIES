import { AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, EyeOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TargetProjection } from '@/lib/kataTarget';

const fmt = (n: number) => Math.round(n).toLocaleString('en-IN');

/**
 * The real reading behind a target-net ticket. Shown on the cabin screen only:
 * the slip prints the target, this tells the operator what was actually loaded
 * and how much to make up on the platform scale.
 */
export function OriginalWeightPanel({
  targetKg,
  liveKg,
  firstKg,
  projection,
}: {
  targetKg: number;
  liveKg: number;
  firstKg: number;
  projection: TargetProjection;
}) {
  const waiting = liveKg <= 0;
  const { actualNetKg, topUpKg, tooFar } = projection;
  const pct = waiting ? 0 : Math.min(100, (actualNetKg / targetKg) * 100);
  const short = topUpKg > 0;
  const over = topUpKg < 0;

  return (
    <section aria-label="Original weight" className="kata-original-card overflow-hidden rounded-[22px] border border-border bg-card">
      <header className="flex items-center justify-between gap-3 border-b border-border/70 px-5 py-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Original weighment</h3>
          <p className="text-[11px] text-muted-foreground">Real scale reading behind the target</p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          <EyeOff className="h-3 w-3" /> Screen only · not printed
        </span>
      </header>

      <div className="grid grid-cols-3 divide-x divide-border/70">
        <Figure label="Scale reading" value={waiting ? null : liveKg} />
        <Figure label="Original net" value={waiting ? null : actualNetKg} strong />
        <Figure label="Target net" value={targetKg} tone="amber" />
      </div>

      <div className="border-t border-border/70 px-5 py-4">
        {waiting ? (
          <p className="text-sm text-muted-foreground">
            First weight {fmt(firstKg)} kg. Waiting for the lorry on the plate…
          </p>
        ) : tooFar ? (
          <div className="flex items-start gap-2.5 rounded-xl bg-red-500/10 px-3 py-2.5 text-sm text-red-700 dark:text-red-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Target is more than 15% away from the real net ({fmt(actualNetKg)} kg). Check the target or clear it - the ticket will not save like this.
            </span>
          </div>
        ) : (
          <>
            <div className="flex items-end justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span
                  className={cn(
                    'flex h-9 w-9 items-center justify-center rounded-xl',
                    short ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300' : over ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300' : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
                  )}
                >
                  {short ? <ArrowUp className="h-4 w-4" /> : over ? <ArrowDown className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                </span>
                <div>
                  <div className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    {short ? 'Top up on platform scale' : over ? 'Over target - unload' : 'On target'}
                  </div>
                  <div className="font-mono text-2xl font-semibold tabular-nums text-foreground">
                    {topUpKg === 0 ? '0' : `${short ? '+' : '−'}${fmt(Math.abs(topUpKg))}`}
                    <span className="ml-1 text-sm font-medium text-muted-foreground">kg</span>
                  </div>
                </div>
              </div>
              <span className="font-mono text-xs text-muted-foreground">{pct.toFixed(1)}% of target</span>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className={cn('h-full rounded-full transition-[width] duration-500', over ? 'bg-rose-500' : short ? 'bg-amber-500' : 'bg-emerald-500')}
                style={{ width: `${pct}%` }}
              />
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function Figure({ label, value, strong, tone }: { label: string; value: number | null; strong?: boolean; tone?: 'amber' }) {
  return (
    <div className="px-5 py-3.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{label}</div>
      <div
        className={cn(
          'mt-1 whitespace-nowrap font-mono tabular-nums',
          strong ? 'text-xl font-semibold text-foreground' : 'text-lg font-medium',
          tone === 'amber' ? 'text-amber-700 dark:text-amber-300' : !strong && 'text-foreground/85',
        )}
      >
        {value != null ? fmt(value) : '—'}
        {value != null && <span className="ml-1 text-xs font-normal text-muted-foreground">kg</span>}
      </div>
    </div>
  );
}
