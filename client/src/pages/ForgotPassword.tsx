import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ArrowLeft, Loader2, Mail } from 'lucide-react';

/**
 * Request a password reset link.
 *
 * The server answers identically whether or not the address has an account, so
 * this screen must too — anything that distinguished them would turn the page
 * into an account-existence oracle. Hence one confirmation message, shown on
 * success regardless.
 */
export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api<{ ok: boolean }>('/auth/forgot-password', {
        method: 'POST',
        body: { email },
      });
      setSent(true);
    } catch (err) {
      // Only a rate limit or an outage reaches here; a missing account does not.
      setError(
        err instanceof ApiError ? err.message : 'Could not send the reset email. Try again shortly.'
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950 px-4">
      <div className="w-full max-w-md">
        <div className="backdrop-blur-xl bg-zinc-900/50 border border-white/10 rounded-3xl p-8 shadow-2xl">
          {sent ? (
            <div className="space-y-5 text-center">
              <h1 className="text-lg font-semibold text-white">Check your email</h1>
              <p className="text-sm text-zinc-400">
                If that address has an account, a reset link is on its way. It can be used once and
                expires in 15 minutes.
              </p>
              <p className="text-xs text-zinc-500">
                Nothing arrived? The address may not be on an account, or it may not have one set.
                Ask whoever administers the ERP to set your password instead.
              </p>
              <Link
                to="/login"
                className="inline-flex items-center gap-2 text-sm text-zinc-300 hover:text-white"
              >
                <ArrowLeft className="h-4 w-4" /> Back to sign in
              </Link>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-6">
              <div className="space-y-2">
                <h1 className="text-lg font-semibold text-white">Reset your password</h1>
                <p className="text-sm text-zinc-400">
                  Enter the email address on your account and we will send a link to set a new
                  password.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="email" className="text-zinc-300 ml-1">Email address</Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-zinc-500" />
                  <Input
                    id="email"
                    type="email"
                    autoComplete="email"
                    autoFocus
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    placeholder="you@example.com"
                    className="login-field pl-10 h-12 !bg-zinc-950/70 border-white/10 !text-white placeholder:text-zinc-500 rounded-xl"
                  />
                </div>
              </div>

              {error && (
                <div className="p-3 text-sm text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg text-center">
                  {error}
                </div>
              )}

              <Button
                type="submit"
                disabled={submitting}
                className="w-full h-12 bg-white text-zinc-950 hover:bg-zinc-200 rounded-xl font-semibold"
              >
                {submitting ? (
                  <><Loader2 className="h-5 w-5 animate-spin" /> Sending</>
                ) : (
                  'Send reset link'
                )}
              </Button>

              <Link
                to="/login"
                className="flex items-center justify-center gap-2 text-xs text-zinc-400 hover:text-zinc-200"
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Back to sign in
              </Link>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
