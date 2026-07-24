// Developer-only screen to run the SaaS licensing gate: set the monthly fee +
// billing day, switch the gate on/off, see how long access is paid for, stop
// services instantly, manage Razorpay auto-pay, and record an offline/cash
// payment. Wired to GET/PUT /api/subscription/config (developer-only server-side).

import { useState, useEffect, useCallback } from 'react';
import {
  CreditCard,
  CheckCircle2,
  AlertCircle,
  Save,
  CalendarClock,
  BadgeCheck,
  Power,
  PlayCircle,
  RefreshCw,
  XCircle,
  History,
  Loader2,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { api, getErrorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface Config {
  active: boolean;
  servicesStopped: boolean;
  monthlyAmount: number; // paise
  billingDay: number;
  paidUntil: string | null;
  daysLeft: number;
  lastPaymentId: string | null;
  subStatus: string | null;
  autopay: boolean;
  razorpayConfigured: boolean;
  webhookConfigured: boolean;
}

interface Payment {
  id: number;
  razorpayOrderId: string | null;
  razorpayPaymentId: string | null;
  razorpaySubId: string | null;
  source: string;
  amount: number;
  status: string;
  periodEnd: string | null;
  createdAt: string;
}

type Msg = { type: 'ok' | 'err'; text: string } | null;

export default function Subscription() {
  const { user } = useAuth();
  const dev = user?.role === 'DEVELOPER';

  const [cfg, setCfg] = useState<Config | null>(null);
  const [amountRs, setAmountRs] = useState('');
  const [billingDay, setBillingDay] = useState('1');
  const [active, setActive] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [paidUntilInput, setPaidUntilInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [paymentsLoading, setPaymentsLoading] = useState(false);

  const applyCfg = (data: Config) => {
    setCfg(data);
    setAmountRs(String((data.monthlyAmount || 0) / 100));
    setBillingDay(String(data.billingDay || 1));
    setActive(!!data.active);
    setStopped(!!data.servicesStopped);
    setPaidUntilInput(data.paidUntil ? data.paidUntil.slice(0, 10) : '');
  };

  const loadPayments = useCallback(async () => {
    setPaymentsLoading(true);
    try {
      const data = await api<Payment[]>('/subscription/payments');
      setPayments(data || []);
    } catch {
      /* silent — payment history is non-critical */
    }
    setPaymentsLoading(false);
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await api<Config>('/subscription/config');
      applyCfg(data);
    } catch (e) {
      setMsg({ type: 'err', text: getErrorMessage(e) || 'Could not load subscription' });
    }
  }, []);

  useEffect(() => {
    if (dev) {
      load();
      loadPayments();
    }
  }, [dev, load, loadPayments]);

  if (!dev) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        This page is only available to the developer account.
      </div>
    );
  }

  const save = async (extra: Record<string, unknown> = {}) => {
    setSaving(true);
    setMsg(null);
    try {
      const body = {
        active,
        monthlyAmount: Math.round(parseFloat(amountRs || '0') * 100), // rupees → paise
        billingDay: parseInt(billingDay, 10),
        ...extra,
      };
      const data = await api<Config>('/subscription/config', { method: 'PUT', body });
      applyCfg(data);
      setMsg({ type: 'ok', text: 'Saved' });
    } catch (e) {
      setMsg({ type: 'err', text: getErrorMessage(e) || 'Save failed' });
    }
    setSaving(false);
  };

  // Instant kill switch. Stopping locks admins & users immediately (they see the
  // payment screen); resuming restores them with paidUntil untouched.
  const toggleServices = async () => {
    const next = !stopped;
    if (
      next &&
      !window.confirm(
        'Stop services now? All admin and user accounts will be locked out immediately until you resume or they complete payment.'
      )
    ) {
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      const data = await api<Config>('/subscription/config', {
        method: 'PUT',
        body: { servicesStopped: next },
      });
      applyCfg(data);
      setMsg({
        type: 'ok',
        text: next ? 'Services stopped — users are locked out.' : 'Services resumed.',
      });
    } catch (e) {
      setMsg({ type: 'err', text: getErrorMessage(e) || 'Action failed' });
    }
    setSaving(false);
  };

  const cancelAutopay = async () => {
    if (!window.confirm('Cancel auto-pay? Access already paid for is kept.')) return;
    setSaving(true);
    setMsg(null);
    try {
      await api('/subscription/cancel', { method: 'POST' });
      await load();
      setMsg({ type: 'ok', text: 'Auto-pay cancelled' });
    } catch (e) {
      setMsg({ type: 'err', text: getErrorMessage(e) || 'Could not cancel auto-pay' });
    }
    setSaving(false);
  };

  const fmtDate = (d: string | null) =>
    d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

  const expired = !!cfg && (!cfg.paidUntil || new Date(cfg.paidUntil) <= new Date());

  return (
    <div className="mx-auto max-w-2xl p-4 sm:p-6 space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
          <CreditCard className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-lg font-semibold">Subscription / Licensing</h1>
          <p className="text-sm text-muted-foreground">
            Control the monthly access fee for this deployment.
          </p>
        </div>
      </div>

      {msg && (
        <div
          className={
            'flex items-center gap-2 rounded-lg px-3 py-2 text-sm ' +
            (msg.type === 'ok'
              ? 'bg-emerald-500/10 text-emerald-600'
              : 'bg-destructive/10 text-destructive')
          }
        >
          {msg.type === 'ok' ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
          {msg.text}
        </div>
      )}

      {/* Current status */}
      <div className="rounded-xl border bg-card/70 backdrop-blur-md p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium">
            <CalendarClock className="h-4 w-4 text-muted-foreground" />
            Access status
          </div>
          <span
            className={
              'rounded-full px-2.5 py-0.5 text-xs font-medium ' +
              (stopped
                ? 'bg-destructive/10 text-destructive'
                : !cfg?.active
                  ? 'bg-muted text-muted-foreground'
                  : expired
                    ? 'bg-destructive/10 text-destructive'
                    : 'bg-emerald-500/10 text-emerald-600')
            }
          >
            {stopped ? 'Stopped' : !cfg?.active ? 'Gate off' : expired ? 'Locked' : 'Active'}
          </span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-xs text-muted-foreground">Paid until</div>
            <div className="font-medium">{fmtDate(cfg?.paidUntil ?? null)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Days left</div>
            <div className="font-medium">{cfg?.daysLeft ?? 0}</div>
          </div>
        </div>
      </div>

      {/* Kill switch */}
      <div
        className={
          'rounded-xl border p-5 ' +
          (stopped ? 'border-destructive/40 bg-destructive/5' : 'bg-card/70 backdrop-blur-md')
        }
      >
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium">
              <Power className={'h-4 w-4 ' + (stopped ? 'text-destructive' : 'text-muted-foreground')} />
              {stopped ? 'Services are stopped' : 'Stop services'}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {stopped
                ? 'Admin & user accounts are locked out right now and see the payment screen. You (developer) still have full access.'
                : 'Instantly lock out all admin & user accounts, regardless of payment date. Use to suspend a client. You keep access.'}
            </div>
          </div>
          <Button
            variant={stopped ? 'default' : 'destructive'}
            onClick={toggleServices}
            disabled={saving}
            className="shrink-0"
          >
            {stopped ? (
              <>
                <PlayCircle className="mr-1.5 h-4 w-4" />
                Resume services
              </>
            ) : (
              <>
                <Power className="mr-1.5 h-4 w-4" />
                Stop services now
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Auto-pay (recurring) */}
      <div className="rounded-xl border bg-card/70 backdrop-blur-md p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium">
            <RefreshCw className="h-4 w-4 text-muted-foreground" />
            Auto-pay (recurring)
          </div>
          <span
            className={
              'rounded-full px-2.5 py-0.5 text-xs font-medium ' +
              (cfg?.autopay ? 'bg-emerald-500/10 text-emerald-600' : 'bg-muted text-muted-foreground')
            }
          >
            {cfg?.autopay ? 'On' : cfg?.subStatus || 'Off'}
          </span>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          When the customer sets up auto-pay from the lock screen, Razorpay charges the monthly fee
          automatically each cycle. Cancelling stops future charges; access already paid for is kept.
        </p>
        {cfg && !cfg.webhookConfigured && (
          <div className="mt-3 flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            RAZORPAY_WEBHOOK_SECRET is not set on the server, so recurring renewals won&apos;t be recorded
            automatically. Add it and register the webhook in the Razorpay dashboard.
          </div>
        )}
        {cfg?.autopay && (
          <div className="mt-4">
            <Button variant="outline" onClick={cancelAutopay} disabled={saving}>
              <XCircle className="mr-1.5 h-4 w-4" />
              Cancel auto-pay
            </Button>
          </div>
        )}
      </div>

      {/* Config */}
      <div className="rounded-xl border bg-card/70 backdrop-blur-md p-5 space-y-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium">
              Licensing gate
              <span
                className={
                  'rounded-full px-2.5 py-0.5 text-xs font-medium ' +
                  (active ? 'bg-emerald-500/10 text-emerald-600' : 'bg-muted text-muted-foreground')
                }
              >
                {active ? 'On' : 'Off'}
              </span>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              When on and unpaid past the paid-through date, admin &amp; users are locked out. You
              (developer) always keep access.
            </div>
          </div>
          <Button
            variant={active ? 'outline' : 'default'}
            onClick={() => save({ active: !active })}
            disabled={saving}
            className="shrink-0"
          >
            <Power className="mr-1.5 h-4 w-4" />
            {active ? 'Turn gate off' : 'Turn gate on'}
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-sm font-medium">Monthly fee (₹)</label>
            <Input
              type="number"
              min="0"
              step="1"
              value={amountRs}
              onChange={(e) => setAmountRs(e.target.value)}
              placeholder="e.g. 2000"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">Billing day (1–28)</label>
            <Input
              type="number"
              min="1"
              max="28"
              value={billingDay}
              onChange={(e) => setBillingDay(e.target.value)}
            />
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium">Access paid until</label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="date"
              value={paidUntilInput}
              onChange={(e) => setPaidUntilInput(e.target.value)}
              className="w-auto"
            />
            <Button
              variant="outline"
              onClick={() =>
                save({
                  // End of the chosen day in the viewer's timezone, so "paid until
                  // 11 Jun" keeps access through all of the 11th.
                  paidUntil: paidUntilInput ? new Date(paidUntilInput + 'T23:59:59').toISOString() : null,
                })
              }
              disabled={saving}
            >
              <CalendarClock className="mr-1.5 h-4 w-4" />
              Update date
            </Button>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            Manually set the paid-through date. Access stays unlocked until the end of this day; clear it
            to lock immediately (when the gate is on).
          </p>
        </div>

        {cfg && !cfg.razorpayConfigured && (
          <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Razorpay keys are not set on the server, so the online “Pay” button is disabled. You can still
            record payments with “Mark as paid” below.
          </div>
        )}

        <div className="flex flex-wrap gap-2 pt-1">
          <Button onClick={() => save()} disabled={saving}>
            <Save className="mr-1.5 h-4 w-4" />
            {saving ? 'Saving…' : 'Save settings'}
          </Button>
          <Button variant="outline" onClick={() => save({ markPaidNow: true })} disabled={saving}>
            <BadgeCheck className="mr-1.5 h-4 w-4" />
            Mark as paid (advance 1 month)
          </Button>
        </div>
      </div>

      {/* Payment History */}
      <div className="rounded-xl border bg-card/70 backdrop-blur-md p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <History className="h-4 w-4 text-muted-foreground" />
            Payment History
          </div>
          <button
            onClick={loadPayments}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <RefreshCw className={'h-3.5 w-3.5 ' + (paymentsLoading ? 'animate-spin' : '')} />
          </button>
        </div>

        {paymentsLoading && payments.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            Loading payments…
          </div>
        ) : payments.length === 0 ? (
          <div className="text-center py-8 text-sm text-muted-foreground">No payments recorded yet.</div>
        ) : (
          <div className="overflow-x-auto -mx-5 px-5">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">Date</th>
                  <th className="pb-2 pr-3 font-medium">Amount</th>
                  <th className="pb-2 pr-3 font-medium">Status</th>
                  <th className="pb-2 pr-3 font-medium">Source</th>
                  <th className="pb-2 pr-3 font-medium">Razorpay ID</th>
                  <th className="pb-2 font-medium">Paid Until</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id} className="border-b last:border-0">
                    <td className="py-2.5 pr-3 whitespace-nowrap">{fmtDate(p.createdAt)}</td>
                    <td className="py-2.5 pr-3 font-medium whitespace-nowrap">
                      ₹{((p.amount || 0) / 100).toLocaleString('en-IN')}
                    </td>
                    <td className="py-2.5 pr-3">
                      <span
                        className={
                          'rounded-full px-2 py-0.5 text-xs font-medium ' +
                          (p.status === 'paid'
                            ? 'bg-emerald-500/10 text-emerald-600'
                            : p.status === 'failed'
                              ? 'bg-destructive/10 text-destructive'
                              : 'bg-muted text-muted-foreground')
                        }
                      >
                        {p.status}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 text-muted-foreground capitalize">{p.source}</td>
                    <td className="py-2.5 pr-3 font-mono text-xs text-muted-foreground">
                      {p.razorpayPaymentId || p.razorpayOrderId || '—'}
                    </td>
                    <td className="py-2.5 whitespace-nowrap">{fmtDate(p.periodEnd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
