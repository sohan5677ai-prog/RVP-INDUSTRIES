import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { PasswordFields, passwordFormReady } from '@/components/PasswordFields';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

/**
 * Set a new password from a reset link.
 *
 * The token arrives in the query string, which is why the server makes it
 * single-use and 15-minute-lived. Nothing is stored client-side and no session
 * is created here: a successful reset revokes every session for the account,
 * including any an intruder might hold, so the user signs in afresh.
 */
export default function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api<{ ok: boolean }>('/auth/reset-password', {
        method: 'POST',
        body: { token, newPassword: password },
      });
      toast.success('Password changed. Please sign in.');
      navigate('/login', { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not reset the password. Try again.'
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-950 px-4">
        <div className="w-full max-w-md backdrop-blur-xl bg-zinc-900/50 border border-white/10 rounded-3xl p-8 text-center space-y-4">
          <h1 className="text-lg font-semibold text-white">That link is incomplete</h1>
          <p className="text-sm text-zinc-400">
            Open the link from your email again, or ask for a new one.
          </p>
          <Link to="/forgot-password" className="text-sm text-zinc-300 hover:text-white underline underline-offset-4">
            Request a new link
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950 px-4 py-10">
      <div className="w-full max-w-md">
        <form
          onSubmit={onSubmit}
          className="backdrop-blur-xl bg-zinc-900/50 border border-white/10 rounded-3xl p-8 shadow-2xl space-y-6"
        >
          <div className="space-y-2">
            <h1 className="text-lg font-semibold text-white">Choose a new password</h1>
            <p className="text-sm text-zinc-400">
              This will sign you out everywhere else, which is what you want if someone else has
              had access.
            </p>
          </div>

          <PasswordFields
            password={password}
            confirm={confirm}
            onPasswordChange={setPassword}
            onConfirmChange={setConfirm}
            idPrefix="reset"
          />

          {error && (
            <div className="p-3 text-sm text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg text-center">
              {error}
            </div>
          )}

          <Button
            type="submit"
            disabled={submitting || !passwordFormReady(password, confirm)}
            className="w-full h-12 bg-white text-zinc-950 hover:bg-zinc-200 rounded-xl font-semibold"
          >
            {submitting ? (
              <><Loader2 className="h-5 w-5 animate-spin" /> Saving</>
            ) : (
              'Set new password'
            )}
          </Button>

          <Link
            to="/login"
            className="flex items-center justify-center gap-2 text-xs text-zinc-400 hover:text-zinc-200"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to sign in
          </Link>
        </form>
      </div>
    </div>
  );
}
