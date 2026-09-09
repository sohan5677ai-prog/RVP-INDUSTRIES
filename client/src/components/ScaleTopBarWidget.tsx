import { useState, useRef, useEffect } from 'react';
import { Scale, Wifi, WifiOff, RefreshCw, Radio, Settings2, AlertTriangle } from 'lucide-react';
import { useScale } from '@/lib/scaleContext';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export default function ScaleTopBarWidget() {
  const {
    isServerStreaming,
    hardwareConnected,
    serverPort,
    availablePorts,
    switchServerPort,
    liveWeight,
    rawText,
    isStable,
    lastUpdated,
    error,
  } = useScale();

  const [isOpen, setIsOpen] = useState(false);
  const [selectedPort, setSelectedPort] = useState(serverPort || 'COM4');
  const [isSwitching, setIsSwitching] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (serverPort) setSelectedPort(serverPort);
  }, [serverPort]);

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

  const handlePortSwitch = async () => {
    if (!selectedPort) return;
    setIsSwitching(true);
    await switchServerPort(selectedPort);
    setIsSwitching(false);
  };

  return (
    <div className="relative inline-block" ref={popoverRef}>
      {/* Topbar Pill Button */}
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className={cn(
          'flex items-center gap-2 h-9 px-3 rounded-lg border text-xs font-medium transition-all shadow-sm',
          hardwareConnected
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/20'
            : isServerStreaming
            ? 'bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-400 hover:bg-amber-500/20'
            : 'bg-card/70 border-border text-muted-foreground hover:bg-accent hover:text-foreground'
        )}
        title="Universal Weighbridge Network Stream"
      >
        <Scale className={cn('h-4 w-4', hardwareConnected ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-500')} />

        {hardwareConnected ? (
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
        ) : (
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
            <span className="font-mono font-medium text-xs">Scale: {serverPort || 'COM4'}</span>
            <span className="text-[10px] text-amber-600/90 dark:text-amber-400/90 font-semibold">(Offline)</span>
          </div>
        )}
      </button>

      {/* Popover / Live Pole Display Modal */}
      {isOpen && (
        <div className="absolute right-0 mt-2 w-88 rounded-xl border border-border bg-card shadow-2xl p-4 z-50 animate-in fade-in-50 zoom-in-95">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border pb-2.5 mb-3">
            <div className="flex items-center gap-2">
              <Radio className="h-4 w-4 text-amber-500 animate-pulse" />
              <div>
                <span className="text-xs font-bold text-foreground block">
                  Scale Network Stream
                </span>
                <span className="text-[10px] text-muted-foreground">
                  Universal Server Broadcast
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {hardwareConnected ? (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                  <Wifi className="h-2.5 w-2.5" /> COM Port Live
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-600 dark:text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full border border-amber-500/20">
                  <WifiOff className="h-2.5 w-2.5" /> Cable Disconnected
                </span>
              )}
            </div>
          </div>

          {/* Digital LED Screen (Matching Pole Display) */}
          <div className="relative rounded-lg bg-zinc-950 p-4 border border-zinc-800 text-center font-mono overflow-hidden shadow-inner">
            <div className="flex justify-between items-center text-[10px] text-zinc-500 mb-1">
              <span className="flex items-center gap-1">
                {hardwareConnected ? (
                  <>
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    LIVE ({serverPort})
                  </>
                ) : (
                  <span className="text-amber-400/90 font-mono">SEARCHING {serverPort}</span>
                )}
              </span>
              <span className={cn('font-semibold uppercase tracking-wider', isStable ? 'text-emerald-400' : 'text-amber-400')}>
                {hardwareConnected ? (isStable ? 'STABLE' : 'MOTION') : 'OFFLINE'}
              </span>
            </div>

            {/* Big Digital Readout */}
            <div className="py-2">
              <span className={cn(
                "text-4xl font-extrabold tracking-wider drop-shadow-[0_0_12px_rgba(52,211,153,0.35)]",
                hardwareConnected ? "text-emerald-400" : "text-stone-500"
              )}>
                {liveWeight != null ? liveWeight.toLocaleString('en-IN') : '0'}
              </span>
              <span className="text-sm font-semibold text-stone-500 ml-2">KG</span>
            </div>

            {/* Raw serial stream info */}
            <div className="mt-1 pt-2 border-t border-zinc-800/80 flex items-center justify-between text-[10px] text-zinc-500">
              <span className="truncate max-w-[180px]">
                {rawText ? <code className="text-zinc-300 font-mono">{rawText}</code> : (error || 'No serial stream detected')}
              </span>
              <span>{lastUpdated ? lastUpdated.toLocaleTimeString() : '-'}</span>
            </div>
          </div>

          {/* Offline Explanation & Port Switcher */}
          {!hardwareConnected && (
            <div className="mt-3 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs space-y-1.5">
              <div className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400 font-medium">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>USB-RS232 Cable not detected on {serverPort}</span>
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                The server is streaming automatically across the local network, but Windows cannot find {serverPort}. Please verify your USB cable is plugged in, or switch ports below:
              </p>

              {/* Port Selector */}
              <div className="pt-2 flex items-center gap-2">
                <select
                  value={selectedPort}
                  onChange={(e) => setSelectedPort(e.target.value)}
                  className="h-8 flex-1 text-xs rounded border border-border bg-background px-2 font-mono text-foreground"
                >
                  <option value="COM4">COM4 (Standard)</option>
                  <option value="COM1">COM1</option>
                  <option value="COM2">COM2</option>
                  <option value="COM3">COM3</option>
                  <option value="COM5">COM5</option>
                  <option value="COM6">COM6</option>
                  <option value="COM7">COM7</option>
                  <option value="COM8">COM8</option>
                  {availablePorts.map((p) => (
                    <option key={p.path} value={p.path}>
                      {p.path} {p.manufacturer ? `(${p.manufacturer})` : ''}
                    </option>
                  ))}
                </select>

                <Button
                  size="sm"
                  variant="outline"
                  onClick={handlePortSwitch}
                  disabled={isSwitching}
                  className="h-8 px-2.5 text-xs font-mono gap-1"
                >
                  {isSwitching ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Settings2 className="h-3 w-3" />}
                  Set Port
                </Button>
              </div>
            </div>
          )}

          {/* Quick Info footer */}
          <div className="mt-3 pt-2 border-t border-border flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Network Broadcast: <strong className="text-foreground">Active</strong></span>
            <span>Manual Override: <strong className="text-foreground">F8</strong></span>
          </div>
        </div>
      )}
    </div>
  );
}
