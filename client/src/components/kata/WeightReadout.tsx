import type { RefObject } from 'react';
import { AlertTriangle, Cable, Keyboard, Lock, Radio, Target, WifiOff } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface WeightReadoutProps {
  /** The live reading: off the scale, or the typed one. */
  weightKg: number;
  isManual: boolean;
  onToggleManual: () => void;
  manualInput: string;
  onManualInput: (value: string) => void;
  inputRef: RefObject<HTMLInputElement>;

  scaleOnline: boolean;
  stable: boolean;
  recentFault: boolean;
  lastFaultTime: number | null;
  /** 'NO DLC' / 'NO DLS' / 'OVERLOAD' / 'SCALE ERROR' while the indicator reports a fault. */
  faultLabel: string | null;
  /** True when the fault was flagged by hand rather than detected. */
  faultFlaggedManually: boolean;
  onToggleFault: () => void;

  portLabel: string;
  viaUsb: boolean;
  canConnectUsb: boolean;
  onConnectUsb: () => void;

  tripType: 'FIRST' | 'SECOND' | 'SINGLE';
  loadType: 'LOAD' | 'EMPTY';
  firstWeightKg: number | null;
  /** Net the ticket will record (the target when one is applied). */
  netKg: number | null;
  /** Second weight the ticket will record (adjusted when a target is applied). */
  recordedSecondKg: number | null;
  /** Target net in force for this weighment, when applied. */
  targetNetKg: number | null;
}

type Tone = 'ok' | 'warn' | 'bad' | 'idle';
type Status = { key: string; label: string; tone: Tone; detail: string };

function statusOf(p: WeightReadoutProps): Status {
  if (p.faultLabel) {
    const detail = p.faultLabel === 'OVERLOAD' ? 'Indicator over range' : p.faultLabel === 'SCALE ERROR' ? 'Indicator reported an error' : 'Load cell signal lost';
    return { key: 'fault', label: p.faultLabel, tone: 'bad', detail };
  }
  if (p.isManual) return { key: 'manual', label: 'Manual', tone: 'warn', detail: 'Typed from the indicator' };
  if (!p.scaleOnline) return { key: 'offline', label: 'Offline', tone: 'idle', detail: `${p.portLabel} not detected` };
  if (p.recentFault) return { key: 'recovering', label: 'Recovering', tone: 'warn', detail: 'Verify against the display' };
  if (p.stable) return { key: 'stable', label: 'Stable', tone: 'ok', detail: 'Reading locked' };
  return { key: 'motion', label: 'In motion', tone: 'warn', detail: 'Wait for it to settle' };
}

const PILL: Record<Tone, string> = {
  ok: 'text-emerald-300 bg-emerald-400/10 ring-emerald-400/25',
  warn: 'text-amber-300 bg-amber-400/10 ring-amber-400/25',
  bad: 'text-red-300 bg-red-500/15 ring-red-400/35',
  idle: 'text-stone-400 bg-white/5 ring-white/10',
};
const DOT: Record<Tone, string> = {
  ok: 'bg-emerald-400 shadow-[0_0_10px_rgb(52_211_153/0.8)]',
  warn: 'bg-amber-400 shadow-[0_0_10px_rgb(251_191_36/0.7)]',
  bad: 'bg-red-500 shadow-[0_0_10px_rgb(239_68_68/0.8)]',
  idle: 'bg-stone-500',
};

const fmt = (n: number) => Math.round(n).toLocaleString('en-IN');

/** Gross, tare and net as the ticket will record them. */
function breakdown(p: WeightReadoutProps) {
  if (p.tripType === 'SECOND' && p.firstWeightKg != null && p.recordedSecondKg != null && p.weightKg > 0) {
    const second = p.recordedSecondKg;
    return {
      gross: Math.max(p.firstWeightKg, second),
      tare: Math.min(p.firstWeightKg, second),
      net: p.netKg,
      ready: true,
    };
  }
  return { gross: null as number | null, tare: null as number | null, net: p.tripType === 'SINGLE' ? p.netKg : null, ready: false };
}

export function WeightReadout(props: WeightReadoutProps) {
  const status = statusOf(props);
  const { gross, tare, net, ready } = breakdown(props);
  const faulted = props.faultLabel !== null;
  const faultAge = props.lastFaultTime ? Math.round((Date.now() - props.lastFaultTime) / 1000) : null;
  // On the second weight the operator cares about the net, not the plate reading.
  const netMode = props.tripType === 'SECOND' && props.firstWeightKg != null;
  const heroKg = netMode ? (props.weightKg > 0 ? props.netKg ?? 0 : 0) : props.weightKg;
  const targetOn = netMode && props.targetNetKg != null;

  return (
    <section aria-label="Live weight" className="kata-console relative overflow-hidden rounded-[22px] text-stone-100">
      {/* Header */}
      <header className="relative z-10 flex flex-wrap items-center justify-between gap-3 px-5 pt-4">
        <div className="flex items-center gap-3">
          <span className={cn('inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ring-1', PILL[status.tone])}>
            <span className={cn('h-1.5 w-1.5 rounded-full', DOT[status.tone])} />
            {status.label}
          </span>
          <span className="hidden text-xs text-stone-400 sm:inline">{status.detail}</span>
        </div>

        <div className="flex items-center gap-2">
          {props.canConnectUsb && (
            <button
              type="button"
              onClick={props.onConnectUsb}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-amber-400 px-3 text-xs font-semibold text-stone-950 transition-colors hover:bg-amber-300"
              title="Connect this browser straight to the scale's USB cable"
            >
              <Cable className="h-3.5 w-3.5" /> Connect USB
            </button>
          )}
          <div role="radiogroup" aria-label="Weight source" className="flex rounded-lg bg-black/30 p-0.5 text-xs font-medium ring-1 ring-white/10">
            <button
              type="button"
              role="radio"
              aria-checked={!props.isManual}
              onClick={() => props.isManual && props.onToggleManual()}
              className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5 transition-colors', !props.isManual ? 'bg-white/10 text-white' : 'text-stone-400 hover:text-stone-200')}
            >
              <Radio className="h-3.5 w-3.5" /> Scale
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={props.isManual}
              onClick={() => !props.isManual && props.onToggleManual()}
              className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5 transition-colors', props.isManual ? 'bg-amber-400 text-stone-950' : 'text-stone-400 hover:text-stone-200')}
              title="Type the weight from the indicator (F8)"
            >
              <Keyboard className="h-3.5 w-3.5" /> Manual <kbd className="font-mono text-[10px] opacity-60">F8</kbd>
            </button>
          </div>
        </div>
      </header>

      {/* Display window */}
      <div className="relative z-10 px-5 pb-1 pt-4">
        <div className="kata-display-window relative rounded-2xl px-5 py-6 sm:px-8">
          <div className="flex items-center justify-between text-[10.5px] font-semibold uppercase tracking-[0.22em] text-stone-400">
            <span className="flex items-center gap-2">
              {netMode ? 'Net weight' : props.tripType === 'SINGLE' ? 'Weight' : 'Live weight'}
              {targetOn && (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-400/15 px-2 py-0.5 text-[10px] tracking-[0.14em] text-amber-300 ring-1 ring-amber-400/30">
                  <Target className="h-3 w-3" /> Target
                </span>
              )}
            </span>
            <span className="font-mono tracking-[0.12em]">{props.viaUsb ? 'USB' : 'NET'} · {props.portLabel}</span>
          </div>

          {faulted && !props.isManual ? (
            <button
              type="button"
              onClick={props.onToggleManual}
              className="mx-auto mt-4 flex w-full max-w-xl flex-col items-center gap-2 rounded-xl border border-red-500/40 bg-red-950/30 px-4 py-5 transition-colors hover:border-red-400"
            >
              <AlertTriangle className="h-7 w-7 text-red-400" />
              <span className="font-mono text-5xl font-semibold tracking-tight text-red-400 md:text-6xl">{props.faultLabel}</span>
              <span className="text-sm text-red-200">The indicator has lost the load cell signal.</span>
              <span className="text-xs font-semibold text-amber-300 underline underline-offset-4">Enter the weight manually (F8)</span>
            </button>
          ) : props.isManual ? (
            <div className="mx-auto mt-3 max-w-md text-center">
              <div className="flex items-baseline justify-center gap-3">
                <input
                  ref={props.inputRef}
                  type="number"
                  inputMode="numeric"
                  value={props.manualInput}
                  onChange={(e) => props.onManualInput(e.target.value)}
                  placeholder="0"
                  aria-label="Manual weight in kilograms"
                  className="w-64 rounded-xl border border-amber-400/60 bg-black/40 px-2 py-1 text-center font-mono text-6xl font-semibold text-amber-300 outline-none focus:border-amber-300"
                  autoFocus
                />
                <span className="font-mono text-xl text-stone-500">kg</span>
              </div>
              {netMode && props.weightKg > 0 && props.netKg != null && (
                <p className="mt-3 font-mono text-sm text-stone-300">
                  Net <span className="text-lg font-semibold text-white">{fmt(props.netKg)} kg</span>
                </p>
              )}
              <p className="mt-1 text-xs text-amber-300/70">The ticket will be stamped MANUAL WEIGHT.</p>
            </div>
          ) : (
            <>
              <div className="mt-2 flex items-baseline justify-center gap-3">
                <span
                  className={cn(
                    'kata-digits font-mono font-semibold tabular-nums',
                    heroKg < 0 ? 'text-red-400' : status.key === 'stable' ? 'text-[#fbf3e4]' : 'text-amber-300',
                  )}
                >
                  {heroKg < 0 ? `−${fmt(Math.abs(heroKg))}` : fmt(heroKg)}
                </span>
                <span className="font-mono text-2xl font-medium text-stone-500">kg</span>
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 font-mono text-[13px] text-stone-400">
                <span>{(heroKg / 1000).toFixed(3)} MT</span>
                {netMode && (
                  <span className="text-stone-500">
                    plate <span className="text-stone-300">{fmt(props.weightKg)}</span> kg
                  </span>
                )}
                {status.key === 'stable' && (
                  <span className="inline-flex items-center gap-1 text-emerald-300">
                    <Lock className="h-3.5 w-3.5" /> Locked
                  </span>
                )}
                {status.key === 'offline' && (
                  <span className="inline-flex items-center gap-1">
                    <WifiOff className="h-3.5 w-3.5" /> Use Manual (F8)
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {!faulted && props.recentFault && (
        <p className="relative z-10 mx-5 mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          A load-cell fault was seen {faultAge != null ? `${faultAge}s ago` : 'recently'}. The scale has recovered - verify this reading against the indicator.
        </p>
      )}

      {/* Ledger: what the ticket will print */}
      <div className="relative z-10 mt-4 grid grid-cols-3 border-t border-white/[0.07]">
        <LedgerCell label="Gross" value={gross} muted={!ready} />
        <LedgerCell label="Tare" value={tare} muted={!ready} />
        <LedgerCell label="Net" value={net} accent />
      </div>

      <div className="relative z-10 flex items-center justify-between border-t border-white/[0.05] px-5 py-2.5">
        <span className="text-[11px] text-stone-500">
          {ready ? 'As printed on the ticket' : 'Gross and tare appear on the second weight'}
        </span>
        <button
          type="button"
          onClick={props.onToggleFault}
          className={cn('text-[11px] font-medium underline-offset-4 hover:underline', props.faultFlaggedManually ? 'text-red-300' : 'text-stone-500 hover:text-stone-300')}
          title="Use if the indicator shows NO DLC but the ERP has not picked it up"
        >
          {props.faultFlaggedManually ? 'Clear manual NO DLC flag' : 'Indicator shows NO DLC?'}
        </button>
      </div>
    </section>
  );
}

function LedgerCell({ label, value, accent, muted }: { label: string; value: number | null; accent?: boolean; muted?: boolean }) {
  return (
    <div className={cn('px-5 py-3.5 [&:not(:first-child)]:border-l [&:not(:first-child)]:border-white/[0.07]', accent && 'bg-amber-400/[0.06]')}>
      <div className={cn('text-[10px] font-semibold uppercase tracking-[0.2em]', accent ? 'text-amber-300/90' : 'text-stone-500')}>{label}</div>
      <div className={cn('mt-1 whitespace-nowrap font-mono text-lg font-medium tabular-nums', accent ? 'text-amber-200' : muted || value == null ? 'text-stone-600' : 'text-stone-100')}>
        {value != null ? fmt(value) : '—'}
        {value != null && <span className="ml-1 text-xs text-stone-500">kg</span>}
      </div>
    </div>
  );
}
