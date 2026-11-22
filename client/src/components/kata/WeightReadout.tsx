import type { RefObject } from 'react';
import { AlertTriangle, Cable, CheckCircle2, Keyboard, Radio, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface WeightReadoutProps {
  /** The weight the ticket will record: the live reading, or the typed one. */
  weightKg: number;
  isManual: boolean;
  onToggleManual: () => void;
  manualInput: string;
  onManualInput: (value: string) => void;
  manualReason: string;
  onManualReason: (value: string) => void;
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
  netKg: number | null;
}

type Status = { key: string; label: string; tone: 'ok' | 'warn' | 'bad' | 'idle'; detail?: string };

function statusOf(p: WeightReadoutProps): Status {
  if (p.faultLabel) {
    const detail = p.faultLabel === 'OVERLOAD' ? 'Indicator over range' : p.faultLabel === 'SCALE ERROR' ? 'Indicator reported an error' : 'Load cell signal lost';
    return { key: 'fault', label: `FAULT · ${p.faultLabel}`, tone: 'bad', detail };
  }
  if (p.isManual) return { key: 'manual', label: 'MANUAL ENTRY', tone: 'warn', detail: 'Typed from the indicator' };
  if (!p.scaleOnline) return { key: 'offline', label: 'SCALE OFFLINE', tone: 'idle', detail: `${p.portLabel} not detected` };
  if (p.recentFault) return { key: 'recovering', label: 'RECOVERING', tone: 'warn', detail: 'Verify against the display' };
  if (p.stable) return { key: 'stable', label: 'STABLE', tone: 'ok', detail: 'Weight is locked - safe to save' };
  return { key: 'motion', label: 'IN MOTION', tone: 'warn', detail: 'Wait for the reading to settle' };
}

const CHIP: Record<Status['tone'], string> = {
  ok: 'border-emerald-400/40 bg-emerald-500/15 text-emerald-300',
  warn: 'border-amber-400/40 bg-amber-500/15 text-amber-300',
  bad: 'border-red-400/50 bg-red-500/20 text-red-300',
  idle: 'border-stone-600 bg-stone-800 text-stone-400',
};
const DOT: Record<Status['tone'], string> = {
  ok: 'bg-emerald-400',
  warn: 'bg-amber-400',
  bad: 'bg-red-500',
  idle: 'bg-stone-500',
};

const fmt = (n: number) => n.toLocaleString('en-IN');

/** Gross, tare and net, labelled by what the lorry was doing on each pass. */
function breakdown(p: WeightReadoutProps) {
  if (p.tripType === 'SECOND' && p.firstWeightKg != null) {
    // On the return pass an EMPTY lorry means the first pass was loaded.
    const firstWasLoaded = p.loadType === 'EMPTY';
    return {
      gross: firstWasLoaded ? p.firstWeightKg : p.weightKg,
      tare: firstWasLoaded ? p.weightKg : p.firstWeightKg,
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

  return (
    <section
      aria-label="Live weight"
      className="kata-scale-panel relative overflow-hidden rounded-2xl border border-stone-800 p-5 text-stone-100"
    >
      {/* Status row */}
      <div className="relative z-10 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            className={cn(
              'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-bold tracking-widest',
              CHIP[status.tone],
            )}
          >
            <span className="relative flex h-2 w-2">
              {status.tone !== 'idle' && (
                <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-60', DOT[status.tone])} />
              )}
              <span className={cn('relative inline-flex h-2 w-2 rounded-full', DOT[status.tone])} />
            </span>
            {status.label}
          </span>
          <span className="hidden text-xs text-stone-400 sm:inline">{status.detail}</span>
        </div>

        <div className="flex items-center gap-2">
          {props.canConnectUsb && (
            <Button
              size="sm"
              onClick={props.onConnectUsb}
              className="h-8 gap-1.5 bg-amber-500 px-3 text-xs font-bold text-stone-950 hover:bg-amber-400"
              title="Connect this browser straight to the scale's USB cable"
            >
              <Cable className="h-3.5 w-3.5" />
              Connect USB
            </Button>
          )}
          {/* Source switch: the scale is the default, typing is the exception */}
          <div role="radiogroup" aria-label="Weight source" className="flex rounded-lg border border-stone-700 bg-stone-900/80 p-0.5 text-xs font-semibold">
            <button
              type="button"
              role="radio"
              aria-checked={!props.isManual}
              onClick={() => props.isManual && props.onToggleManual()}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 transition-colors',
                !props.isManual ? 'bg-stone-700 text-stone-50' : 'text-stone-400 hover:text-stone-200',
              )}
            >
              <Radio className="h-3.5 w-3.5" /> Scale
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={props.isManual}
              onClick={() => !props.isManual && props.onToggleManual()}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 transition-colors',
                props.isManual ? 'bg-amber-500 text-stone-950' : 'text-stone-400 hover:text-stone-200',
              )}
              title="Type the weight from the indicator (F8). A reason is required."
            >
              <Keyboard className="h-3.5 w-3.5" /> Manual <kbd className="font-mono text-[10px] opacity-70">F8</kbd>
            </button>
          </div>
        </div>
      </div>

      {/* Readout */}
      <div className="relative z-10 py-6 text-center">
        {faulted && !props.isManual ? (
          <button
            type="button"
            onClick={props.onToggleManual}
            className="mx-auto flex w-full max-w-xl flex-col items-center gap-2 rounded-2xl border border-red-500/50 bg-red-950/30 px-4 py-5 transition-colors hover:border-red-400"
          >
            <AlertTriangle className="h-8 w-8 text-red-400" />
            <span className="font-mono text-5xl font-black tracking-tight text-red-400 md:text-6xl">{props.faultLabel}</span>
            <span className="text-sm text-red-200">The indicator has lost the load cell signal.</span>
            <span className="text-xs font-semibold text-amber-300 underline underline-offset-4">Enter the weight manually (F8)</span>
          </button>
        ) : props.isManual ? (
          <div className="mx-auto max-w-md">
            <div className="flex items-baseline justify-center gap-3">
              <input
                ref={props.inputRef}
                type="number"
                inputMode="numeric"
                value={props.manualInput}
                onChange={(e) => props.onManualInput(e.target.value)}
                placeholder="0"
                aria-label="Manual weight in kilograms"
                className="w-64 rounded-xl border-2 border-amber-500 bg-stone-900 px-2 py-1 text-center font-mono text-6xl font-black text-amber-400 outline-none"
                autoFocus
              />
              <span className="font-mono text-2xl font-bold text-stone-400">kg</span>
            </div>
            <input
              type="text"
              value={props.manualReason}
              onChange={(e) => props.onManualReason(e.target.value)}
              placeholder="Why is it being typed? (required)"
              maxLength={80}
              aria-label="Reason for manual weight"
              className="mt-3 w-full rounded-lg border border-amber-500/50 bg-stone-900 px-3 py-2 text-center text-sm text-amber-100 outline-none placeholder:text-amber-300/40 focus:border-amber-400"
            />
            <p className="mt-2 text-xs text-amber-300/80">This ticket will be stamped MANUAL WEIGHT with your reason.</p>
          </div>
        ) : (
          <>
            <div className="flex items-baseline justify-center gap-3">
              <span
                className={cn(
                  'kata-weight-digits font-mono font-black tabular-nums',
                  props.weightKg < 0 ? 'text-red-400' : status.key === 'stable' ? 'text-emerald-300' : 'text-amber-400',
                )}
              >
                {props.weightKg < 0 ? `−${fmt(Math.abs(props.weightKg))}` : fmt(props.weightKg)}
              </span>
              <span className="font-mono text-2xl font-bold text-stone-400">kg</span>
            </div>
            <div className="mt-2 flex items-center justify-center gap-3 font-mono text-sm text-stone-400">
              <span>{(props.weightKg / 1000).toFixed(3)} MT</span>
              {status.key === 'stable' && (
                <span className="inline-flex items-center gap-1 text-emerald-300">
                  <CheckCircle2 className="h-4 w-4" /> Locked
                </span>
              )}
              {status.key === 'offline' && (
                <span className="inline-flex items-center gap-1 text-stone-400">
                  <WifiOff className="h-4 w-4" /> Use Manual (F8)
                </span>
              )}
            </div>
          </>
        )}
      </div>

      {/* Recovery notice */}
      {!faulted && props.recentFault && (
        <p className="relative z-10 mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          A load-cell fault was detected {faultAge != null ? `${faultAge}s ago` : 'recently'}. The scale has recovered, but verify
          this reading against the physical display.
        </p>
      )}

      {/* Gross / tare / net */}
      <div className="relative z-10 grid grid-cols-3 gap-2 border-t border-stone-800 pt-4">
        <Cell label="Gross" value={gross} muted={!ready} hint={ready ? undefined : 'after 2nd weight'} />
        <Cell label="Tare" value={tare} muted={!ready} hint={ready ? undefined : 'after 2nd weight'} />
        <Cell label="Net" value={net} accent />
      </div>

      <div className="relative z-10 mt-3 flex justify-end">
        <button
          type="button"
          onClick={props.onToggleFault}
          className={cn(
            'text-[11px] font-medium underline-offset-4 hover:underline',
            props.faultFlaggedManually ? 'text-red-300' : 'text-stone-500 hover:text-stone-300',
          )}
          title="Use if the indicator shows NO DLC but the ERP has not picked it up"
        >
          {props.faultFlaggedManually ? 'Clear manual NO DLC flag' : 'Indicator shows NO DLC?'}
        </button>
      </div>
    </section>
  );
}

function Cell({ label, value, accent, muted, hint }: { label: string; value: number | null; accent?: boolean; muted?: boolean; hint?: string }) {
  return (
    <div className={cn('rounded-xl border px-3 py-2.5 text-center', accent ? 'border-amber-500/40 bg-amber-500/10' : 'border-stone-800 bg-stone-900/70')}>
      <div className={cn('text-[10px] font-bold uppercase tracking-[0.14em]', accent ? 'text-amber-400' : 'text-stone-500')}>{label}</div>
      <div className={cn('mt-1 whitespace-nowrap font-mono text-base font-bold tabular-nums sm:text-lg', accent ? 'text-amber-300' : muted ? 'text-stone-600' : 'text-stone-100')}>
        {value != null ? `${fmt(value)} kg` : '—'}
      </div>
      {hint && value == null && <div className="text-[10px] text-stone-600">{hint}</div>}
    </div>
  );
}
