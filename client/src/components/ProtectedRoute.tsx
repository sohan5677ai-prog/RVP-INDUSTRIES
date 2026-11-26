import { useState } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '@/lib/auth';

export default function ProtectedRoute() {
  const { user, loading, paused } = useAuth();

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center text-muted-foreground">Loading…</div>;
  }
  if (!user) {
    if (localStorage.getItem('rvp_kata_cabin_installation_key')) {
      return <Navigate to="/kata-cabin" replace />;
    }
    return <Navigate to="/login" replace />;
  }
  // Rendering this instead of the app unmounts every page, poll and heartbeat,
  // so a remembered device left idle sends the server nothing at all.
  if (paused) return <PausedScreen />;
  return <Outlet />;
}

function PausedScreen() {
  const { user, resume, logout } = useAuth();
  const [busy, setBusy] = useState(false);

  const onContinue = async () => {
    setBusy(true);
    try {
      await resume();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0a0a0c] px-4 text-white">
      <div className="w-full max-w-sm rounded-3xl border border-white/10 bg-[#111113] p-8 text-center shadow-2xl">
        <p className="text-xs uppercase tracking-[0.3em] text-white/50">Paused</p>
        <h1 className="mt-3 text-xl font-semibold">Welcome back{user?.name ? `, ${user.name}` : ''}</h1>
        <p className="mt-2 text-sm text-white/60">
          This remembered device was idle for 20 minutes. Continue where you left off, no password needed.
        </p>
        <button
          type="button"
          onClick={onContinue}
          disabled={busy}
          autoFocus
          className="mt-6 w-full rounded-2xl bg-white py-3 font-medium text-black transition hover:bg-white/90 disabled:opacity-60"
        >
          {busy ? 'Reconnecting… (server may take a moment to wake)' : 'Continue'}
        </button>
        <button
          type="button"
          onClick={logout}
          className="mt-4 text-sm text-white/50 underline-offset-4 hover:text-white hover:underline"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
