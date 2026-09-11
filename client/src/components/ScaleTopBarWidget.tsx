import { useState, useRef, useEffect } from 'react';
import { Scale, Wifi, WifiOff, RefreshCw, Radio, Settings2, AlertTriangle, CheckCircle2, Cable } from 'lucide-react';
import { useScale } from '@/lib/scaleContext';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export default function ScaleTopBarWidget() {
  const {
    isSupported,
    isScaleOnline,
    connectionMode,
    serverPort,
    availablePorts,
    switchServerPort,
    liveWeight,
    rawText,
    isStable,
    lastUpdated,
    error,
    connect,
    isConnecting,
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
          isScaleOnline
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/20'
            : 'bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-400 hover:bg-amber-500/20'
        )}
        title="Universal Weighbridge Scale Stream"
      >
        <Scale className={cn('h-4 w-4', isScaleOnline ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-500')} />

        {isScaleOnline ? (
          <div className="flex items-center gap-1.5">
            <span className="relative flex h-2 w-2">
              <span className={cn("animate-ping absolute inline-flex h-full w-full rounded-full opacity-75", isStable ? "bg-emerald-400" : "bg-amber-400")} />
              <span className={cn("relative inline-flex rounded-full h-2 w-2", isStable ? "bg-emerald-500" : "bg-amber-500")} />
            </span>
            <span className="font-mono font-bold text-sm tracking-tight text-foreground">
              {liveWeight != null ? liveWeight.toLocaleString('en-IN') : '0'}
            </span>
            <span className="text-[10px] uppercase font-bold text-muted-foreground">kg</span>
            {connectionMode === 'LOCAL_USB' ? (
              <span className="text-[9px] font-mono px-1 py-0.2 rounded bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 font-bold ml-0.5">
                USB
              </span>
            ) : (
              <span className="text-[9px] font-mono px-1 py-0.2 rounded bg-sky-500/20 text-sky-700 dark:text-sky-300 font-bold ml-0.5">
                HUB
              </span>
            )}
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
        <div className="absolute right-0 mt-2 w-96 rounded-xl border border-border bg-card shadow-2xl p-4 z-50 animate-in fade-in-50 zoom-in-95">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border pb-2.5 mb-3">
            <div className="flex items-center gap-2">
              <Radio className={cn("h-4 w-4", isScaleOnline ? "text-emerald-500 animate-pulse" : "text-amber-500")} />
              <div>
                <span className="text-xs font-bold text-foreground block">
                  Scale Network Stream
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {connectionMode === 'LOCAL_USB'
                    ? 'Kata Cabin Terminal (Universal Broadcaster)'
                    : connectionMode === 'NETWORK_STREAM'
                    ? 'Universal Network Stream (Kata Cabin Hub)'
                    : 'Universal Server Broadcast'}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {isScaleOnline ? (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                  <Wifi className="h-2.5 w-2.5" /> {connectionMode === 'LOCAL_USB' ? 'USB Live' : 'Hub Live'}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-600 dark:text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full border border-amber-500/20">
                  <WifiOff className="h-2.5 w-2.5" /> Disconnected
                </span>
              )}
            </div>
          </div>

          {/* Digital LED Screen (Matching Pole Display) */}
          <div className="relative rounded-lg bg-zinc-950 p-4 border border-zinc-800 text-center font-mono overflow-hidden shadow-inner">
            <div className="flex justify-between items-center text-[10px] text-zinc-500 mb-1">
              <span className="flex items-center gap-1">
                {isScaleOnline ? (
                  <>
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="text-emerald-400 font-bold">
                      LIVE ({serverPort || 'COM4'}{connectionMode === 'LOCAL_USB' ? ' · USB' : ' · NET'})
                    </span>
                  </>
                ) : (
                  <span className="text-amber-400/90 font-mono">SEARCHING {serverPort || 'COM4'}</span>
                )}
              </span>
              <span className={cn('font-semibold uppercase tracking-wider', isStable ? 'text-emerald-400' : 'text-amber-400')}>
                {isScaleOnline ? (isStable ? 'STABLE' : 'MOTION') : 'OFFLINE'}
              </span>
            </div>

            {/* Big Digital Readout */}
            <div className="py-2">
              <span className={cn(
                "text-5xl font-extrabold tracking-wider transition-colors",
                isScaleOnline ? "text-emerald-400 drop-shadow-[0_0_15px_rgba(52,211,153,0.4)]" : "text-stone-500"
              )}>
                {liveWeight != null ? liveWeight.toLocaleString('en-IN') : '0'}
              </span>
              <span className="text-sm font-semibold text-stone-500 ml-2">KG</span>
            </div>

            {/* Raw serial stream info */}
            <div className="mt-1 pt-2 border-t border-zinc-800/80 flex items-center justify-between text-[10px] text-zinc-500">
              <span className="truncate max-w-[210px]">
                {rawText ? <code className="text-zinc-300 font-mono">{rawText}</code> : (error || 'No serial stream detected')}
              </span>
              <span>{lastUpdated ? lastUpdated.toLocaleTimeString() : '-'}</span>
            </div>
          </div>

          {/* Mode 1: Local USB connected on this PC (Kata Cabin Terminal) */}
          {connectionMode === 'LOCAL_USB' && (
            <div className="mt-3 p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-xs space-y-1">
              <div className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400 font-semibold">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>USB Cable Connected on this Terminal</span>
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                This computer is actively reading the weighbridge indicator via USB and <strong>broadcasting live weight universally</strong> across the local network to all office systems.
              </p>
            </div>
          )}

          {/* Mode 2: Universal Network Stream (Remote PC, e.g. Office PC) */}
          {connectionMode === 'NETWORK_STREAM' && (
            <div className="mt-3 p-2.5 rounded-lg bg-sky-500/10 border border-sky-500/20 text-xs space-y-1">
              <div className="flex items-center gap-1.5 text-sky-700 dark:text-sky-400 font-semibold">
                <Radio className="h-4 w-4 shrink-0 animate-pulse text-sky-500" />
                <span>Universal Network Stream Active</span>
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                Receiving real-time weighbridge data broadcasted from the Kata Cabin weighbridge terminal over the local network.
              </p>
            </div>
          )}

          {/* Mode 3: Actually Offline */}
          {!isScaleOnline && (
            <div className="mt-3 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs space-y-1.5">
              <div className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400 font-medium">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>No Scale Stream Detected</span>
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                If this is the Kata Cabin PC, please ensure the USB-RS232 cable is plugged in and click "Connect USB Scale" below:
              </p>

              {isSupported && (
                <div className="pt-1">
                  <Button
                    size="sm"
                    onClick={() => connect()}
                    disabled={isConnecting}
                    className="w-full h-8 text-xs font-semibold gap-1.5 bg-amber-600 hover:bg-amber-700 text-white shadow-xs"
                  >
                    <Cable className="h-3.5 w-3.5" />
                    {isConnecting ? 'Connecting...' : 'Connect USB Scale (Web Serial)'}
                  </Button>
                </div>
              )}

              {/* Server Port Selector */}
              <div className="pt-2 flex items-center gap-2 border-t border-amber-500/20">
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
            <span>
              Network Broadcast:{' '}
              <strong className={isScaleOnline ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground'}>
                {isScaleOnline ? 'Live Streaming' : 'Ready'}
              </strong>
            </span>
            <span>Manual Override: <strong className="text-foreground">F8</strong></span>
          </div>
        </div>
      )}
    </div>
  );
}
