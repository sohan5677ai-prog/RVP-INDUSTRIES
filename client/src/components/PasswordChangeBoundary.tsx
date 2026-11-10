import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordFields, passwordFormReady } from '@/components/PasswordFields';
import { Loader2, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';

/**
 * Blocks the app when the signed-in account must change its password.
 *
 * `mustChangePassword` is set whenever someone else chose the password — an
 * admin creating the account or resetting it — because until the owner changes
 * it, it is not a secret between them and the system. Enforced here as well as
 * on the server; this is the part that makes it unavoidable rather than
 * merely suggested.
 */
export default function PasswordChangeBoundary() {
  const { user, adoptSession, logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!user?.mustChangePassword) return <Outlet />;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      // Hands back a fresh token pair: the old access token carries the old
      // passwordChangedAt and stops being valid the moment this succeeds.
      const res = await api<Parameters<typeof adoptSession>[0]>('/auth/change-password', {
        method: 'POST',
        body: { currentPassword, newPassword: password },
      });
      adoptSession(res);
      toast.success('Password changed. Your other devices have been signed out.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the password.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950 px-4 py-10">
      <div className="w-full max-w-md">
        <form
          onSubmit={onSubmit}
          className="backdrop-blur-xl bg-zinc-900/50 border border-white/10 rounded-3xl p-8 shadow-2xl space-y-6"
        >
          <div className="flex items-start gap-3">
            <ShieldAlert className="h-5 w-5 text-amber-400 mt-0.5 shrink-0" />
            <div className="space-y-1">
              <h1 className="text-lg font-semibold text-white">Choose your own password</h1>
              <p className="text-sm text-zinc-400">
                Your password was set for you, so someone else knows it. Pick one only you know
                before carrying on.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="pcb-current" className="text-zinc-300 ml-1">Current password</Label>
            <Input
              id="pcb-current"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
              className="login-field h-12 !bg-zinc-950/70 border-white/10 !text-white rounded-xl"
            />
          </div>

          <PasswordFields
            password={password}
            confirm={confirm}
            onPasswordChange={setPassword}
            onConfirmChange={setConfirm}
            context={{ username: user.username, name: user.name }}
            idPrefix="pcb"
          />

          {error && (
            <div className="p-3 text-sm text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg text-center">
              {error}
            </div>
          )}

          <Button
            type="submit"
            disabled={
              submitting ||
              !currentPassword ||
              !passwordFormReady(password, confirm, { username: user.username, name: user.name })
            }
            className="w-full h-12 bg-white text-zinc-950 hover:bg-zinc-200 rounded-xl font-semibold"
          >
            {submitting ? (
              <><Loader2 className="h-5 w-5 animate-spin" /> Saving</>
            ) : (
              'Change password and continue'
            )}
          </Button>

          <button
            type="button"
            onClick={logout}
            className="w-full text-xs text-zinc-500 hover:text-zinc-300"
          >
            Sign out instead
          </button>
        </form>
      </div>
    </div>
  );
}
