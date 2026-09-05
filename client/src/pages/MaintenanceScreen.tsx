import { useEffect, useState, useMemo, useCallback } from 'react';
import {
  Clock,
  ShieldCheck,
  RefreshCw,
  LogOut,
  Sparkles,
  CheckCircle2,
  Terminal,
  Activity,
  AlertCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, clearToken } from '@/lib/api';
import type { MaintenanceStatus } from '@/lib/types';

interface MaintenanceScreenProps {
  initialStatus?: MaintenanceStatus | null;
  onResolved?: () => void;
}

export default function MaintenanceScreen({
  initialStatus,
  onResolved,
}: MaintenanceScreenProps) {
  const [status, setStatus] = useState<MaintenanceStatus | null>(initialStatus ?? null);
  const [secondsLeft, setSecondsLeft] = useState<number>(() => {
    if (initialStatus?.endsAt) {
      const diff = Math.floor((new Date(initialStatus.endsAt).getTime() - Date.now()) / 1000);
      return Math.max(0, diff);
    }
    return initialStatus?.secondsLeft ?? 600;
  });
  const [checking, setChecking] = useState(false);
  const [isDone, setIsDone] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date>(new Date());

  // Fetch latest maintenance status from server
  const checkStatus = useCallback(async () => {
    setChecking(true);
    try {
      const res = await api<MaintenanceStatus>('/system/maintenance/status');
      setLastCheckedAt(new Date());
      setStatus(res);

      if (!res.isUnderMaintenance) {
        setIsDone(true);
        setTimeout(() => {
          if (onResolved) onResolved();
          else window.location.reload();
        }, 1200);
      } else if (res.endsAt) {
        const diff = Math.floor((new Date(res.endsAt).getTime() - Date.now()) / 1000);
        setSecondsLeft(Math.max(0, diff));
      }
    } catch {
      // Server might still be starting/restarting, keep current display
    } finally {
      setChecking(false);
    }
  }, [onResolved]);

  // Initial fetch and sync
  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  // Periodic poll every 5 seconds to detect early finish or time extensions in real-time
  useEffect(() => {
    const pollInterval = setInterval(() => {
      checkStatus();
    }, 5000);
    return () => clearInterval(pollInterval);
  }, [checkStatus]);

  // Ticking countdown clock every 1 second
  useEffect(() => {
    if (secondsLeft <= 0) {
      checkStatus();
      return;
    }

    const timer = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          checkStatus();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [secondsLeft, checkStatus]);

  // Calculate hours, minutes, seconds
  const hours = Math.floor(secondsLeft / 3600);
  const minutes = Math.floor((secondsLeft % 3600) / 60);
  const seconds = secondsLeft % 60;

  // Format digital string with zero pad
  const format2 = (n: number) => String(n).padStart(2, '0');

  // Total duration in seconds for progress calculation
  const totalDurationSeconds = useMemo(() => {
    if (!status?.startedAt || !status?.endsAt) {
      return (status?.durationMinutes || 10) * 60;
    }
    const start = new Date(status.startedAt).getTime();
    const end = new Date(status.endsAt).getTime();
    const diff = Math.floor((end - start) / 1000);
    return diff > 0 ? diff : 600;
  }, [status?.startedAt, status?.endsAt, status?.durationMinutes]);

  // Progress percentage (0% to 100%)
  const progressPercent = useMemo(() => {
    if (totalDurationSeconds <= 0) return 0;
    const elapsed = totalDurationSeconds - secondsLeft;
    const pct = (elapsed / totalDurationSeconds) * 100;
    return Math.min(100, Math.max(0, Math.round(pct)));
  }, [totalDurationSeconds, secondsLeft]);

  // Estimated recovery time
  const estimatedTimeFormatted = useMemo(() => {
    if (!status?.endsAt) return null;
    const date = new Date(status.endsAt);
    return date.toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
  }, [status?.endsAt]);

  const handleLogout = () => {
    clearToken();
    window.location.href = '/login';
  };

  // Circular SVG ring properties
  const radius = 88;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (progressPercent / 100) * circumference;

  return (
    <div className="relative min-h-screen w-full flex flex-col items-center justify-center overflow-x-hidden overflow-y-auto bg-background text-foreground p-4 sm:p-6 select-none font-sans">
      {/* ── Lightweight Hardware-Accelerated Ambient Glow (Zero-Lag) ── */}
      <div
        className="fixed inset-0 pointer-events-none opacity-40 dark:opacity-20"
        style={{
          background:
            'radial-gradient(circle at 50% 15%, rgba(245, 158, 11, 0.18) 0%, transparent 60%), radial-gradient(circle at 85% 85%, rgba(217, 119, 6, 0.12) 0%, transparent 50%)',
        }}
      />

      <div className="relative z-10 w-full max-w-2xl flex flex-col items-center my-auto py-8 animate-in fade-in zoom-in-95 duration-300">
        {/* ── Brand & Status Pill ── */}
        <div className="flex flex-col items-center text-center mb-6">
          <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-amber-500/15 border border-amber-500/30 shadow-sm mb-4">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-500 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-600 dark:bg-amber-500" />
            </span>
            <span className="text-[11px] font-bold tracking-[0.18em] uppercase text-amber-800 dark:text-amber-300">
              {isDone ? 'MAINTENANCE COMPLETE' : 'SYSTEM MAINTENANCE IN PROGRESS'}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-amber-500 to-amber-700 flex items-center justify-center shadow-md ring-1 ring-amber-400/30">
              <span className="font-display font-bold text-lg text-white leading-none">R</span>
            </div>
            <div className="text-left">
              <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-foreground flex items-center gap-2">
                RVP Industries ERP
              </h1>
              <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground font-medium">
                Tamarind Seed Processing • Enterprise Platform
              </p>
            </div>
          </div>
        </div>

        {/* ── Main Container Card ── */}
        <div className="w-full rounded-3xl bg-card border border-border p-6 sm:p-8 shadow-xl flex flex-col items-center relative overflow-hidden">
          {/* Top accent highlight */}
          <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-transparent via-amber-500/60 to-transparent" />

          {isDone ? (
            /* Celebration state when maintenance ends */
            <div className="py-12 flex flex-col items-center text-center animate-in zoom-in-90 duration-300">
              <div className="h-20 w-20 rounded-full bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center mb-5 text-emerald-600 dark:text-emerald-400 shadow-lg">
                <CheckCircle2 className="h-10 w-10" />
              </div>
              <h2 className="text-2xl font-bold text-foreground mb-2">Maintenance Complete!</h2>
              <p className="text-sm text-muted-foreground max-w-md mb-6">
                All systems have been successfully updated and verified. Restoring your session right now...
              </p>
              <div className="flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400 font-semibold">
                <RefreshCw className="h-4 w-4 animate-spin" />
                Loading application...
              </div>
            </div>
          ) : (
            <>
              {/* ── Radial Countdown Ring & Digital Clock ── */}
              <div className="relative flex items-center justify-center my-3">
                {/* SVG Progress Ring */}
                <svg className="w-60 h-60 sm:w-68 sm:h-68 -rotate-90 transform">
                  {/* Track circle */}
                  <circle
                    cx="50%"
                    cy="50%"
                    r={radius}
                    className="stroke-muted/80 dark:stroke-muted/40"
                    strokeWidth="9"
                    fill="transparent"
                  />
                  {/* Progress circle */}
                  <circle
                    cx="50%"
                    cy="50%"
                    r={radius}
                    stroke="currentColor"
                    className="text-amber-600 dark:text-amber-400 transition-all duration-1000 ease-linear"
                    strokeWidth="9"
                    strokeDasharray={circumference}
                    strokeDashoffset={strokeDashoffset}
                    strokeLinecap="round"
                    fill="transparent"
                  />
                </svg>

                {/* Digital Clock in Center */}
                <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
                  <div className="text-[10px] uppercase font-bold tracking-[0.24em] text-amber-800 dark:text-amber-400/90 mb-1.5 flex items-center gap-1.5">
                    <Clock className="h-3 w-3" />
                    TIME REMAINING
                  </div>

                  {/* Digital Clock Display */}
                  <div className="flex items-baseline justify-center gap-1 sm:gap-1.5 font-mono text-3xl sm:text-4xl font-bold tracking-tight">
                    {hours > 0 && (
                      <>
                        <div className="flex flex-col items-center">
                          <span className="bg-muted/70 border border-border px-2.5 py-1.5 rounded-xl shadow-xs text-amber-700 dark:text-amber-300">
                            {format2(hours)}
                          </span>
                          <span className="text-[9px] font-sans uppercase font-semibold text-muted-foreground mt-1">HRS</span>
                        </div>
                        <span className="text-muted-foreground font-bold self-center -mt-3 text-2xl">:</span>
                      </>
                    )}

                    <div className="flex flex-col items-center">
                      <span className="bg-muted/70 border border-border px-2.5 py-1.5 rounded-xl shadow-xs text-amber-700 dark:text-amber-300">
                        {format2(minutes)}
                      </span>
                      <span className="text-[9px] font-sans uppercase font-semibold text-muted-foreground mt-1">MIN</span>
                    </div>

                    <span className="text-muted-foreground font-bold self-center -mt-3 text-2xl">:</span>

                    <div className="flex flex-col items-center">
                      <span className="bg-muted/70 border border-border px-2.5 py-1.5 rounded-xl shadow-xs text-amber-700 dark:text-amber-300">
                        {format2(seconds)}
                      </span>
                      <span className="text-[9px] font-sans uppercase font-semibold text-muted-foreground mt-1">SEC</span>
                    </div>
                  </div>

                  {/* Progress percentage pill */}
                  <div className="mt-3 px-2.5 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/30 text-[10px] font-mono text-amber-800 dark:text-amber-300 font-semibold">
                    {progressPercent}% Elapsed
                  </div>
                </div>
              </div>

              {/* ── Estimated Completion Bar ── */}
              {estimatedTimeFormatted && (
                <div className="w-full max-w-md bg-muted/40 border border-border rounded-xl p-3 flex items-center justify-between text-xs mb-5">
                  <div className="flex items-center gap-2 text-foreground font-medium">
                    <Activity className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
                    <span>Estimated Reopening:</span>
                  </div>
                  <span className="font-mono font-semibold text-amber-800 dark:text-amber-300 bg-amber-500/15 px-2 py-0.5 rounded border border-amber-500/30">
                    {estimatedTimeFormatted} IST
                  </span>
                </div>
              )}

              {/* ── Message from the Developer Card ── */}
              <div className="w-full rounded-2xl bg-muted/30 border border-amber-500/30 p-5 sm:p-6 mb-6 text-left relative overflow-hidden">
                <div className="flex items-start gap-3.5">
                  <div className="h-10 w-10 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center shrink-0 text-amber-700 dark:text-amber-400">
                    <Terminal className="h-5 w-5" />
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <h3 className="font-semibold text-sm sm:text-base text-foreground">
                        {status?.title || 'System Maintenance in Progress'}
                      </h3>
                      <span className="inline-flex items-center gap-1 text-[10px] font-semibold bg-amber-500/15 border border-amber-500/30 text-amber-800 dark:text-amber-300 px-2 py-0.5 rounded-full">
                        <ShieldCheck className="h-3 w-3" />
                        Developer Notice
                      </span>
                    </div>

                    <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap mt-2">
                      {status?.message ||
                        'We are currently performing scheduled maintenance, database upgrades and core performance tuning. All your data is secure.'}
                    </p>

                    {status?.contactInfo && (
                      <div className="mt-3 pt-3 border-t border-border flex items-center gap-2 text-[11px] text-muted-foreground">
                        <AlertCircle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
                        <span>Support Line: {status.contactInfo}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* ── Status Controls & Live Polling Pulse ── */}
              <div className="w-full flex flex-col sm:flex-row items-center justify-between gap-3 pt-1">
                <div className="flex items-center gap-2 text-xs text-muted-foreground font-medium">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-600 dark:bg-emerald-500" />
                  </span>
                  <span>
                    Synced at{' '}
                    {lastCheckedAt.toLocaleTimeString('en-IN', {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                      hour12: true,
                    })}
                  </span>
                </div>

                <div className="flex items-center gap-2 w-full sm:w-auto">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={checkStatus}
                    disabled={checking}
                    className="flex-1 sm:flex-initial h-9 bg-card hover:bg-muted border-border text-foreground text-xs font-medium gap-1.5 cursor-pointer"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${checking ? 'animate-spin text-amber-600 dark:text-amber-400' : ''}`} />
                    {checking ? 'Checking…' : 'Check Status Now'}
                  </Button>

                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleLogout}
                    className="h-9 text-muted-foreground hover:text-destructive hover:bg-destructive/10 text-xs font-medium gap-1.5 cursor-pointer"
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    Sign Out
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>

        {/* ── Footer ── */}
        <p className="text-center text-xs text-muted-foreground mt-6 flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
          RVP Industries ERP • All transactional records & balances remain fully protected.
        </p>
      </div>
    </div>
  );
}
