import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { api, ApiError } from '@/lib/api';
import type { MaintenanceStatus } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Lock, Mail, Loader2, ArrowRight, Eye, EyeOff, Wrench, Clock, ShieldAlert } from 'lucide-react';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Maintenance mode detection on login page
  const [maintenance, setMaintenance] = useState<MaintenanceStatus | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    let alive = true;
    const checkMaint = async () => {
      try {
        const res = await api<MaintenanceStatus>('/system/maintenance/status');
        if (!alive) return;
        setMaintenance(res);
        if (res.isUnderMaintenance && res.endsAt) {
          const diff = Math.floor((new Date(res.endsAt).getTime() - Date.now()) / 1000);
          setSecondsLeft(Math.max(0, diff));
        }
      } catch {
        /* fail open */
      }
    };
    checkMaint();
    const interval = setInterval(checkMaint, 6000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!maintenance?.isUnderMaintenance || secondsLeft <= 0) return;
    const timer = setInterval(() => {
      setSecondsLeft((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [maintenance?.isUnderMaintenance, secondsLeft]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(username, password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Invalid credentials. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const mins = Math.floor(secondsLeft / 60);
  const secs = secondsLeft % 60;
  const timeStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-zinc-950">
      {/* Premium Background Gradients */}
      <div className="absolute -top-[20%] -left-[10%] w-[50%] h-[50%] rounded-full bg-violet-600/30 blur-[120px]" />
      <div className="absolute -bottom-[20%] -right-[10%] w-[50%] h-[50%] rounded-full bg-amber-600/20 blur-[120px]" />
      <div className="absolute top-[20%] right-[10%] w-[30%] h-[30%] rounded-full bg-emerald-600/20 blur-[100px]" />

      <div className="relative z-10 w-full max-w-md p-6 sm:p-10">
        {/* Brand Header */}
        <div className="flex flex-col items-center text-center mb-8">
          <div className="h-16 w-16 mb-6 rounded-2xl bg-gradient-to-br from-amber-400 to-amber-700 flex items-center justify-center shadow-2xl shadow-amber-900/50 ring-1 ring-white/10">
            <span className="font-display font-bold text-3xl text-amber-50">R</span>
          </div>
          <h1 className="font-display text-3xl font-bold tracking-tight text-white mb-2">RVP Industries</h1>
          <p className="text-zinc-400 text-sm tracking-wide">ENTERPRISE RESOURCE PLANNING</p>
        </div>

        {/* Maintenance Banner on Login */}
        {maintenance?.isUnderMaintenance && (
          <div className="mb-6 rounded-2xl bg-gradient-to-r from-amber-500/20 via-orange-500/20 to-amber-600/20 border border-amber-500/40 p-4 shadow-xl backdrop-blur-xl animate-in fade-in slide-in-from-top-2">
            <div className="flex items-start gap-3">
              <div className="h-9 w-9 rounded-xl bg-amber-500/20 border border-amber-400/30 flex items-center justify-center shrink-0 text-amber-400 mt-0.5">
                <Wrench className="h-4 w-4" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-xs font-bold uppercase tracking-wider text-amber-300 flex items-center gap-1.5">
                    <ShieldAlert className="h-3.5 w-3.5" />
                    Maintenance Active
                  </span>
                  <span className="font-mono text-xs font-bold bg-amber-400/20 text-amber-300 border border-amber-400/30 px-2 py-0.5 rounded-md">
                    <Clock className="inline h-3 w-3 mr-1 -mt-0.5" />
                    {timeStr} Left
                  </span>
                </div>
                <p className="text-xs text-zinc-300 mt-1.5 leading-relaxed line-clamp-3">
                  {maintenance.message || 'System maintenance in progress. Non-developer logins are temporarily paused.'}
                </p>
                <div className="mt-2 text-[10.5px] text-amber-200/70">
                  Developer accounts can still sign in below.
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Glass Card */}
        <div className="backdrop-blur-xl bg-zinc-900/50 border border-white/10 rounded-3xl p-8 shadow-2xl">
          <form onSubmit={onSubmit} className="space-y-6">
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="username" className="text-zinc-300 ml-1">Username</Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-zinc-500" />
                  <Input
                    id="username"
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                    placeholder="admin"
                    className="login-field pl-10 h-12 !bg-zinc-950/70 border-white/10 !text-white placeholder:text-zinc-500 focus-visible:ring-amber-500/50 rounded-xl"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between ml-1">
                  <Label htmlFor="password" className="text-zinc-300">Password</Label>
                </div>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-zinc-500" />
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    placeholder="••••••••"
                    className="login-field pl-10 pr-10 h-12 !bg-zinc-950/70 border-white/10 !text-white placeholder:text-zinc-500 focus-visible:ring-amber-500/50 rounded-xl"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 focus:outline-none"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? (
                      <EyeOff className="h-5 w-5" />
                    ) : (
                      <Eye className="h-5 w-5" />
                    )}
                  </button>
                </div>
              </div>
            </div>

            {error && (
              <div className="p-3 text-sm text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg text-center animate-in fade-in slide-in-from-top-1">
                {error}
              </div>
            )}

            <Button 
              type="submit" 
              className="w-full h-12 bg-white text-zinc-950 hover:bg-zinc-200 rounded-xl font-semibold tracking-wide flex items-center justify-center gap-2 transition-all hover:gap-3" 
              disabled={submitting}
            >
              {submitting ? (
                <><Loader2 className="h-5 w-5 animate-spin" /> Authenticating</>
              ) : (
                <>Sign In <ArrowRight className="h-4 w-4" /></>
              )}
            </Button>
          </form>
        </div>

        {/* Footer */}
        <p className="text-center text-xs text-zinc-500 mt-8">
          Secure access restricted to authorized personnel only.<br />
          &copy; {new Date().getFullYear()} RVP Industries.
        </p>
      </div>
    </div>
  );
}
