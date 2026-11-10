import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PasswordFields, passwordFormReady } from '@/components/PasswordFields';
import {
  AlertTriangle,
  Check,
  Copy,
  Loader2,
  LogOut,
  ShieldCheck,
  ShieldOff,
  Smartphone,
} from 'lucide-react';
import { toast } from 'sonner';

/**
 * Account security: two-factor enrolment, password change, and signing out
 * everywhere.
 *
 * The enrolment flow is three steps on purpose — show the QR, verify a code,
 * then show the recovery codes. The account is not actually protected until a
 * code has verified (the server leaves `mfaEnabledAt` null until then), so a
 * half-finished enrolment cannot lock anyone out.
 */

interface EnrolmentStart {
  secret: string;
  otpauthUri: string;
  qrDataUrl: string;
}

type Stage = 'idle' | 'scanning' | 'codes';

export default function SecuritySettings() {
  const { user, refreshUser, adoptSession, logout } = useAuth();

  const [stage, setStage] = useState<Stage>('idle');
  const [enrolment, setEnrolment] = useState<EnrolmentStart | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedCodes, setSavedCodes] = useState(false);

  // Password change
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);

  // Disabling MFA
  const [disablePassword, setDisablePassword] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [showDisable, setShowDisable] = useState(false);

  if (!user) return null;

  const enrolled = !!user.mfaEnrolled;
  const required = !!user.mfaEnrolmentRequired || (enrolled && isPrivileged(user.role));

  async function beginEnrolment() {
    setError(null);
    setBusy(true);
    try {
      const res = await api<EnrolmentStart>('/auth/mfa/enrol', { method: 'POST' });
      setEnrolment(res);
      setStage('scanning');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start setup.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnrolment(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api<{ recoveryCodes: string[] }>('/auth/mfa/enrol/confirm', {
        method: 'POST',
        body: { code },
      });
      setRecoveryCodes(res.recoveryCodes);
      setStage('codes');
      setCode('');
      await refreshUser();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That code was not correct.');
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwError(null);
    setPwBusy(true);
    try {
      const res = await api<Parameters<typeof adoptSession>[0]>('/auth/change-password', {
        method: 'POST',
        body: { currentPassword, newPassword },
      });
      // A fresh pair: the old access token stops working the instant this
      // succeeds, because it predates the new passwordChangedAt.
      adoptSession(res);
      setCurrentPassword('');
      setNewPassword('');
      setConfirm('');
      toast.success('Password changed. Your other devices have been signed out.');
    } catch (err) {
      setPwError(err instanceof ApiError ? err.message : 'Could not change the password.');
    } finally {
      setPwBusy(false);
    }
  }

  async function turnOffMfa(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api('/auth/mfa/disable', {
        method: 'POST',
        body: { currentPassword: disablePassword, code: disableCode },
      });
      setShowDisable(false);
      setDisablePassword('');
      setDisableCode('');
      await refreshUser();
      toast.success('Two-factor authentication turned off.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not turn it off.');
    } finally {
      setBusy(false);
    }
  }

  async function signOutEverywhere() {
    try {
      await api('/auth/logout-all', { method: 'POST' });
      toast.success('Signed out on every device.');
      logout();
    } catch {
      toast.error('Could not sign out the other devices.');
    }
  }

  function copyCodes() {
    navigator.clipboard
      .writeText(recoveryCodes.join('\n'))
      .then(() => toast.success('Recovery codes copied.'))
      .catch(() => toast.error('Could not copy. Write them down instead.'));
  }

  return (
    <div className="space-y-4">
      {/* ------------------------------------------------ two-factor ------ */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Smartphone className="h-4 w-4" />
                Two-factor authentication
              </CardTitle>
              <CardDescription>
                A code from your phone as well as your password, so a stolen password is not
                enough on its own.
              </CardDescription>
            </div>
            <span
              className={`shrink-0 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                enrolled
                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                  : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
              }`}
            >
              {enrolled ? <ShieldCheck className="h-3.5 w-3.5" /> : <ShieldOff className="h-3.5 w-3.5" />}
              {enrolled ? 'On' : 'Off'}
            </span>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {!enrolled && required && stage === 'idle' && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              <p className="text-muted-foreground">
                Your role requires two-factor authentication. Set it up now — once it is enforced,
                accounts without it will not be able to sign in.
              </p>
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-rose-500/20 bg-rose-500/10 p-3 text-sm text-rose-500">
              {error}
            </div>
          )}

          {stage === 'idle' && !enrolled && (
            <Button onClick={beginEnrolment} disabled={busy}>
              {busy ? <><Loader2 className="h-4 w-4 animate-spin" /> Starting</> : 'Set up two-factor'}
            </Button>
          )}

          {stage === 'idle' && enrolled && !showDisable && (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-muted-foreground">
                Set up and active on this account.
              </p>
              {!required && (
                <Button variant="outline" size="sm" onClick={() => setShowDisable(true)}>
                  Turn off
                </Button>
              )}
              {required && (
                <p className="text-xs text-muted-foreground">
                  It cannot be switched off for your role.
                </p>
              )}
            </div>
          )}

          {stage === 'scanning' && enrolment && (
            <form onSubmit={confirmEnrolment} className="space-y-4">
              <ol className="space-y-4 text-sm">
                <li>
                  <p className="font-medium">1. Scan this with your authenticator app</p>
                  <p className="text-muted-foreground text-xs mb-2">
                    Google Authenticator, Microsoft Authenticator, Authy — any of them.
                  </p>
                  <img
                    src={enrolment.qrDataUrl}
                    alt="QR code for two-factor setup"
                    width={200}
                    height={200}
                    className="rounded-lg border bg-white p-2"
                  />
                </li>
                <li>
                  <p className="font-medium">Cannot scan it?</p>
                  <p className="text-muted-foreground text-xs">
                    Type this key into the app instead:
                  </p>
                  <code className="mt-1 inline-block break-all rounded bg-muted px-2 py-1 font-mono text-xs">
                    {enrolment.secret}
                  </code>
                </li>
                <li className="space-y-2">
                  <Label htmlFor="mfa-setup-code" className="font-medium">
                    2. Enter the 6-digit code it shows
                  </Label>
                  <Input
                    id="mfa-setup-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="123456"
                    required
                    className="max-w-[180px] text-center tracking-[0.3em]"
                  />
                </li>
              </ol>

              <div className="flex gap-2">
                <Button type="submit" disabled={busy || code.length < 6}>
                  {busy ? <><Loader2 className="h-4 w-4 animate-spin" /> Verifying</> : 'Verify and turn on'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => { setStage('idle'); setEnrolment(null); setCode(''); setError(null); }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}

          {stage === 'codes' && (
            <div className="space-y-4">
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <p className="text-muted-foreground">
                  Save these somewhere safe and offline — printed, or in a password manager. Each
                  one works once, to get in if you lose your phone.{' '}
                  <strong className="text-foreground">They cannot be shown again.</strong>
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-4 font-mono text-sm sm:grid-cols-3">
                {recoveryCodes.map((c) => (
                  <span key={c}>{c}</span>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button variant="outline" size="sm" onClick={copyCodes}>
                  <Copy className="h-3.5 w-3.5" /> Copy codes
                </Button>
                <label className="flex cursor-pointer select-none items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={savedCodes}
                    onChange={(e) => setSavedCodes(e.target.checked)}
                    className="h-4 w-4"
                  />
                  I have saved these codes
                </label>
                <Button
                  size="sm"
                  disabled={!savedCodes}
                  onClick={() => { setStage('idle'); setRecoveryCodes([]); setSavedCodes(false); }}
                >
                  <Check className="h-3.5 w-3.5" /> Done
                </Button>
              </div>
            </div>
          )}

          {showDisable && (
            <form onSubmit={turnOffMfa} className="space-y-3 rounded-lg border p-4">
              <p className="text-sm text-muted-foreground">
                Both factors are needed to remove a factor — a signed-in session alone is not
                enough.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="mfa-off-pw">Current password</Label>
                  <Input
                    id="mfa-off-pw"
                    type="password"
                    autoComplete="current-password"
                    value={disablePassword}
                    onChange={(e) => setDisablePassword(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="mfa-off-code">Authentication code</Label>
                  <Input
                    id="mfa-off-code"
                    inputMode="numeric"
                    value={disableCode}
                    onChange={(e) => setDisableCode(e.target.value)}
                    required
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <Button type="submit" variant="destructive" size="sm" disabled={busy}>
                  Turn off two-factor
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setShowDisable(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      {/* -------------------------------------------------- password ------ */}
      <Card>
        <CardHeader>
          <CardTitle>Password</CardTitle>
          <CardDescription>
            Changing it signs you out on every other device straight away.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={changePassword} className="max-w-md space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="sec-current">Current password</Label>
              <Input
                id="sec-current"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
              />
            </div>

            <PasswordFields
              password={newPassword}
              confirm={confirm}
              onPasswordChange={setNewPassword}
              onConfirmChange={setConfirm}
              context={{ username: user.username, name: user.name }}
              idPrefix="sec"
            />

            {pwError && (
              <div className="rounded-lg border border-rose-500/20 bg-rose-500/10 p-3 text-sm text-rose-500">
                {pwError}
              </div>
            )}

            <Button
              type="submit"
              disabled={
                pwBusy ||
                !currentPassword ||
                !passwordFormReady(newPassword, confirm, {
                  username: user.username,
                  name: user.name,
                })
              }
            >
              {pwBusy ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving</> : 'Change password'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* ----------------------------------------------- sessions --------- */}
      <Card>
        <CardHeader>
          <CardTitle>Signed-in devices</CardTitle>
          <CardDescription>
            If you think someone else has access, sign out everywhere and change your password.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={signOutEverywhere}>
            <LogOut className="h-4 w-4" /> Sign out on all devices
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

/** Mirrors MFA_REQUIRED_ROLES in server/src/lib/mfa.ts. */
function isPrivileged(role: string): boolean {
  return role === 'ADMIN' || role === 'OWNER' || role === 'DEVELOPER';
}
