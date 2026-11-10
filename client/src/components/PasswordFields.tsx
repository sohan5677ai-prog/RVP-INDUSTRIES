import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Check, Eye, EyeOff, X } from 'lucide-react';

/** Mirrors MIN_PASSWORD_LENGTH in server/src/lib/passwordPolicy.ts. */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * New-password entry with a confirmation and live feedback.
 *
 * The checks shown here are a courtesy, not the policy: the server validates
 * independently and is the only thing that decides. They exist so someone does
 * not submit four times to discover four separate rules — the server returns
 * every problem at once for the same reason.
 */
export interface PasswordFieldsProps {
  password: string;
  confirm: string;
  onPasswordChange: (v: string) => void;
  onConfirmChange: (v: string) => void;
  /** Used for the "must not contain your name" hint. */
  context?: { username?: string; name?: string };
  idPrefix?: string;
}

interface Rule {
  label: string;
  ok: boolean;
}

export function passwordRules(password: string, context?: { username?: string; name?: string }): Rule[] {
  const lower = password.toLowerCase();
  const personal = [context?.username, context?.name]
    .filter((v): v is string => !!v)
    .flatMap((v) => [v, ...v.split(/[\s._-]+/)])
    .filter((v) => v.length >= 3)
    .map((v) => v.toLowerCase());

  return [
    { label: `At least ${MIN_PASSWORD_LENGTH} characters`, ok: password.length >= MIN_PASSWORD_LENGTH },
    { label: 'Not a commonly used password', ok: !isObviouslyCommon(lower) },
    {
      label: 'Does not contain your name or username',
      ok: password.length === 0 || !personal.some((p) => lower.includes(p)),
    },
    { label: 'No leading or trailing spaces', ok: password === password.trim() },
  ];
}

/**
 * A deliberately small echo of the server blocklist — just enough to catch the
 * obvious before a round trip. The authoritative list lives on the server.
 */
function isObviouslyCommon(lower: string): boolean {
  if (!lower) return false;
  const stripped = lower.replace(/[\d\W_]+$/, '');
  const deleet = stripped
    .replace(/[4@]/g, 'a')
    .replace(/3/g, 'e')
    .replace(/[1!|]/g, 'i')
    .replace(/0/g, 'o')
    .replace(/[5$]/g, 's');
  return ['password', 'qwerty', 'admin', 'welcome', 'letmein', 'rvp', 'tamarind', '123456'].some(
    (bad) => deleet === bad || stripped === bad
  );
}

export function PasswordFields({
  password,
  confirm,
  onPasswordChange,
  onConfirmChange,
  context,
  idPrefix = 'pw',
}: PasswordFieldsProps) {
  const [show, setShow] = useState(false);
  const rules = passwordRules(password, context);
  const mismatch = confirm.length > 0 && confirm !== password;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-new`} className="text-zinc-300 ml-1">New password</Label>
        <div className="relative">
          <Input
            id={`${idPrefix}-new`}
            type={show ? 'text' : 'password'}
            autoComplete="new-password"
            value={password}
            onChange={(e) => onPasswordChange(e.target.value)}
            required
            className="login-field h-12 pr-10 !bg-zinc-950/70 border-white/10 !text-white rounded-xl"
          />
          <button
            type="button"
            onClick={() => setShow(!show)}
            aria-label={show ? 'Hide password' : 'Show password'}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
          >
            {show ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-confirm`} className="text-zinc-300 ml-1">Confirm new password</Label>
        <Input
          id={`${idPrefix}-confirm`}
          type={show ? 'text' : 'password'}
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => onConfirmChange(e.target.value)}
          required
          className="login-field h-12 !bg-zinc-950/70 border-white/10 !text-white rounded-xl"
        />
        {mismatch && <p className="text-xs text-rose-400 ml-1">The two passwords do not match.</p>}
      </div>

      <ul className="space-y-1.5 text-xs">
        {rules.map((r) => (
          <li key={r.label} className="flex items-center gap-2">
            {r.ok ? (
              <Check className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
            ) : (
              <X className="h-3.5 w-3.5 text-zinc-600 shrink-0" />
            )}
            <span className={r.ok ? 'text-zinc-400' : 'text-zinc-500'}>{r.label}</span>
          </li>
        ))}
      </ul>

      <p className="text-xs text-zinc-500">
        A few unrelated words make a better password than a short one with symbols in it.
      </p>
    </div>
  );
}

/** True when the form is worth submitting. The server still decides. */
export function passwordFormReady(
  password: string,
  confirm: string,
  context?: { username?: string; name?: string }
): boolean {
  return password === confirm && passwordRules(password, context).every((r) => r.ok);
}
