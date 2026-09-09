import { useState, useRef, useEffect } from 'react';
import { Scale, Wifi, WifiOff, RefreshCw } from 'lucide-react';
import { useScale } from '@/lib/scaleContext';
import { cn } from '@/lib/utils';

export default function ScaleTopBarWidget() {
  const {
    isSupported,
    isConnected,
    isConnecting,
    liveWeight,
    rawText,
    isStable,
    lastUpdated,
    baudRate,
    setBaudRate,
    autoConnect,
    setAutoConnect,
    connect,
    disconnect,
  } = useScale();

  const [isOpen, setIsOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close popover when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  if (!isSupported) {
    return null; // Only render on browsers that support Web Serial (Chrome / Edge)
  }

  return (
    <div className="relative inline-block" ref={popoverRef}>
      {/* Topbar Pill Button */}
      <button
        type="button"
        onClick={() => {
          if (!isConnected && !isConnecting) {
            connect();
          } else {
            setIsOpen((prev) => !prev);
          }
        }}
        className={cn(
          'flex items-center gap-2 h-9 px-3 rounded-lg border text-xs font-medium transition-all shadow-sm',
          isConnected
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/20'
            : isConnecting
            ? 'bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-400 animate-pulse'
            : 'bg-card/70 border-border text-muted-foreground hover:bg-accent hover:text-foreground'
        )}
        title={isConnected ? 'Click to open Scale details' : 'Connect Weighbridge (COM4)'}
      >
        <Scale className={cn('h-4 w-4', isConnected ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground')} />

        {isConnected ? (
          <div className="flex items-center gap-1.5">
            <span className="relative flex h-2 w-2">
              <span className={cn("animate-ping absolute inline-flex h-full w-full rounded-full opacity-75", isStable ? "bg-emerald-400" : "bg-amber-400")} />
              <span className={cn("relative inline-flex rounded-full h-2 w-2", isStable ? "bg-emerald-500" : "bg-amber-500")} />
            </span>
            <span className="font-mono font-bold text-sm tracking-tight text-foreground">
              {liveWeight != null ? liveWeight.toLocaleString('en-IN') : '0'}
            </span>
            <span className="text-[10px] uppercase font-bold text-muted-foreground">kg</span>
          </div>
        ) : isConnecting ? (
          <div className="flex items-center gap-1.5">
            <RefreshCw className="h-3 w-3 animate-spin" />
            <span>Connecting...</span>
          </div>
        ) : (
          <span>Connect Scale</span>
        )}
      </button>

      {/* Popover / Live Pole Display Modal */}
      {isOpen && (
        <div className="absolute right-0 mt-2 w-80 rounded-xl border border-border bg-card shadow-2xl p-4 z-50 animate-in fade-in-50 zoom-in-95">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border pb-2.5 mb-3">
            <div className="flex items-center gap-2">
              <Scale className="h-4 w-4 text-primary" />
              <span className="text-xs font-semibold text-foreground uppercase tracking-wider">
                Weighbridge Indicator
              </span>
            </div>
            <div className="flex items-center gap-1">
              {isConnected ? (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full">
                  <Wifi className="h-2.5 w-2.5" /> COM Port Live
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                  <WifiOff className="h-2.5 w-2.5" /> Disconnected
                </span>
              )}
            </div>
          </div>

          {/* Digital LED Screen (Matching Pole Display) */}
          <div className="relative rounded-lg bg-zinc-950 p-4 border border-zinc-800 text-center font-mono overflow-hidden shadow-inner">
            <div className="flex justify-between items-center text-[10px] text-zinc-500 mb-1">
              <span className="flex items-center gap-1">
                {isConnected && (
                  <>
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    LIVE
                  </>
                )}
              </span>
              <span className={cn('font-semibold uppercase tracking-wider', isStable ? 'text-emerald-400' : 'text-amber-400')}>
                {isStable ? 'STABLE' : 'MOTION'}
              </span>
            </div>

            {/* Big Digital Readout */}
            <div className="py-2">
              <span className="text-4xl font-extrabold tracking-wider text-emerald-400 drop-shadow-[0_0_12px_rgba(52,211,153,0.35)]">
                {liveWeight != null ? liveWeight.toLocaleString('en-IN') : '0'}
              </span>
              <span className="text-sm font-semibold text-emerald-600 dark:text-emerald-400/70 ml-2">KG</span>
            </div>

            {/* Raw serial stream info */}
            <div className="mt-1 pt-2 border-t border-zinc-800/80 flex items-center justify-between text-[10px] text-zinc-500">
              <span>Stream: <code className="text-zinc-300 font-mono">{rawText || 'Waiting...'}</code></span>
              <span>{lastUpdated ? lastUpdated.toLocaleTimeString() : '-'}</span>
            </div>
          </div>

          {/* Quick Actions */}
          <div className="mt-4 space-y-2.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Baud Rate:</span>
              <select
                value={baudRate}
                onChange={(e) => setBaudRate(Number(e.target.value))}
                disabled={isConnected}
                className="h-7 text-xs rounded border border-border bg-background px-2 font-mono text-foreground"
              >
                <option value={2400}>2400 (COM4 Default)</option>
                <option value={4800}>4800</option>
                <option value={9600}>9600</option>
              </select>
            </div>

            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <label htmlFor="scale-autoconnect" className="cursor-pointer">Auto-connect on open:</label>
              <input
                id="scale-autoconnect"
                type="checkbox"
                checked={autoConnect}
                onChange={(e) => setAutoConnect(e.target.checked)}
                className="h-4 w-4 rounded border-border accent-primary cursor-pointer"
              />
            </div>

            <div className="pt-2 border-t border-border flex items-center gap-2">
              {isConnected ? (
                <button
                  type="button"
                  onClick={() => disconnect()}
                  className="w-full py-1.5 px-3 rounded-lg border border-destructive/40 bg-destructive/10 text-destructive text-xs font-semibold hover:bg-destructive/20 transition-colors"
                >
                  Disconnect Scale
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => connect()}
                  disabled={isConnecting}
                  className="w-full py-1.5 px-3 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 transition-colors flex items-center justify-center gap-1.5"
                >
                  {isConnecting ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Wifi className="h-3.5 w-3.5" />}
                  Connect COM4
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
