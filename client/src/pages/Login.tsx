import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Lock, Mail, Loader2, ArrowRight, Eye, EyeOff } from 'lucide-react';

const INTRO_SEEN_KEY = 'rvp-intro-seen';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Intro plays once per browser session; the video's final frame is pitch
  // black, matching the zinc-950 page behind it for a seamless reveal.
  // Skipped entirely for users who prefer reduced motion.
  const [introDone, setIntroDone] = useState(
    () =>
      sessionStorage.getItem(INTRO_SEEN_KEY) === '1' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
  const [introFading, setIntroFading] = useState(false);
  // The pod waits on its first frame until the user clicks or presses Enter.
  const [introStarted, setIntroStarted] = useState(false);
  const introVideoRef = useRef<HTMLVideoElement>(null);

  function finishIntro() {
    if (introDone || introFading) return;
    sessionStorage.setItem(INTRO_SEEN_KEY, '1');
    setIntroFading(true);
    setTimeout(() => setIntroDone(true), 900);
  }

  function startIntro() {
    if (introStarted) return;
    setIntroStarted(true);
    const vid = introVideoRef.current;
    if (!vid) return finishIntro();
    vid.muted = true;
    vid.play().catch(() => finishIntro());
  }

  useEffect(() => {
    if (introDone) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Enter' || e.key === ' ') startIntro();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [introDone, introStarted]);

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

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-zinc-950">
      {/* Cinematic intro — tamarind pod burst, ends on a black frame */}
      {!introDone && (
        <div
          onClick={startIntro}
          role="button"
          aria-label="Play intro animation, then continue to sign in"
          className={`fixed inset-0 z-50 cursor-pointer bg-black transition-opacity duration-700 ${introFading ? 'opacity-0' : 'opacity-100'}`}
        >
          <video
            ref={introVideoRef}
            src="/intro-tamarind.mp4"
            poster="/intro-tamarind-poster.jpg"
            muted
            playsInline
            preload="auto"
            onEnded={finishIntro}
            onError={finishIntro}
            className="h-full w-full object-cover"
          />
          {/* Brand header — fades out once the burst begins */}
          <div
            className={`absolute inset-x-0 top-10 sm:top-14 flex flex-col items-center text-center transition-opacity duration-500 ${
              introStarted ? 'opacity-0' : 'opacity-100'
            }`}
          >
            <div className="h-14 w-14 mb-4 rounded-2xl bg-gradient-to-br from-amber-400 to-amber-700 flex items-center justify-center shadow-2xl shadow-black/60 ring-1 ring-white/10">
              <span className="font-display font-bold text-2xl text-amber-50">R</span>
            </div>
            <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-white drop-shadow-[0_2px_12px_rgba(0,0,0,0.8)]">
              RVP Industries
            </h1>
            <p className="mt-2 text-xs sm:text-sm tracking-[0.25em] text-white/60">
              ENTERPRISE RESOURCE PLANNING
            </p>
          </div>
          {!introStarted && (
            <div className="absolute inset-x-0 bottom-16 flex justify-center">
              <p className="animate-pulse text-xs tracking-[0.3em] text-white/60">
                CLICK OR PRESS ENTER
              </p>
            </div>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              finishIntro();
            }}
            className="absolute bottom-6 right-6 rounded-full border border-white/20 bg-black/40 px-4 py-1.5 text-xs tracking-widest text-white/70 backdrop-blur-sm transition-colors hover:bg-black/60 hover:text-white"
          >
            SKIP
          </button>
        </div>
      )}

      {/* Premium Background Gradients */}
      <div className="absolute -top-[20%] -left-[10%] w-[50%] h-[50%] rounded-full bg-violet-600/30 blur-[120px]" />
      <div className="absolute -bottom-[20%] -right-[10%] w-[50%] h-[50%] rounded-full bg-amber-600/20 blur-[120px]" />
      <div className="absolute top-[20%] right-[10%] w-[30%] h-[30%] rounded-full bg-emerald-600/20 blur-[100px]" />

      <div
        className={`relative z-10 w-full max-w-md p-6 sm:p-10 ${
          introFading ? 'animate-in fade-in zoom-in-95 duration-1000' : ''
        }`}
      >
        {/* Brand Header */}
        <div className="flex flex-col items-center text-center mb-8">
          <div className="h-16 w-16 mb-6 rounded-2xl bg-gradient-to-br from-amber-400 to-amber-700 flex items-center justify-center shadow-2xl shadow-amber-900/50 ring-1 ring-white/10">
            <span className="font-display font-bold text-3xl text-amber-50">R</span>
          </div>
          <h1 className="font-display text-3xl font-bold tracking-tight text-white mb-2">RVP Industries</h1>
          <p className="text-zinc-400 text-sm tracking-wide">ENTERPRISE RESOURCE PLANNING</p>
        </div>

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
