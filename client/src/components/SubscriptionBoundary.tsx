// Layout route that wraps the authenticated app. When the logged-in
// (non-developer) user's subscription is expired it renders the full-screen
// Paywall instead of the app. This is the *visible* half of the gate — the
// backend 402 is the real enforcement.
//
// It reacts to a "subscription:locked" window event too, so if access expires
// mid-session (any API call returns 402, dispatched by the api layer) the
// paywall appears without a manual refresh.
//
// When 1–2 days remain, a warning modal is shown with an "OK, I will pay later"
// option. The dismissal is session-scoped so it re-appears on next login.

import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { AlertTriangle, CreditCard, X } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import Paywall from '@/pages/Paywall';

interface SubStatus {
  locked: boolean;
  daysLeft: number | null;
  amount: number;
}

const rupees = (paise: number) =>
  `₹${((paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export default function SubscriptionBoundary() {
  const { user } = useAuth();
  // Only non-developer users are gated. The developer (vendor) always passes.
  const mustCheck = !!user && user.role !== 'DEVELOPER';

  const [locked, setLocked] = useState(false);
  const [daysLeft, setDaysLeft] = useState<number | null>(null);
  const [amount, setAmount] = useState(0);
  const [checked, setChecked] = useState(!mustCheck);
  const [reminderDismissed, setReminderDismissed] = useState(
    () => sessionStorage.getItem('sub_reminder_dismissed') === '1'
  );

  useEffect(() => {
    let alive = true;

    if (!mustCheck) {
      setChecked(true);
      return;
    }

    api<SubStatus>('/subscription/status')
      .then((s) => {
        if (!alive) return;
        setLocked(!!s.locked);
        setDaysLeft(s.daysLeft ?? null);
        setAmount(s.amount || 0);
      })
      .catch(() => {
        /* network / server error — fail open, don't lock on a hiccup */
      })
      .finally(() => {
        if (alive) setChecked(true);
      });

    // A 402 anywhere in the app flips us to the paywall immediately.
    const onLocked = () => setLocked(true);
    window.addEventListener('subscription:locked', onLocked);
    return () => {
      alive = false;
      window.removeEventListener('subscription:locked', onLocked);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mustCheck]);

  const dismissReminder = () => {
    sessionStorage.setItem('sub_reminder_dismissed', '1');
    setReminderDismissed(true);
  };

  // Avoid flashing the app before the status resolves.
  if (mustCheck && !checked) return null;

  // Hard lock — no bypass allowed (expired or services stopped).
  if (locked) return <Paywall />;

  const showReminder =
    mustCheck && daysLeft !== null && daysLeft > 0 && daysLeft <= 2 && !reminderDismissed;

  return (
    <>
      <Outlet />

      {showReminder && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="relative w-full max-w-md rounded-2xl border bg-card/90 backdrop-blur-md p-8 shadow-2xl text-center animate-in fade-in zoom-in-95 duration-200">
            <button
              onClick={dismissReminder}
              className="absolute top-4 right-4 text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="h-4 w-4" />
            </button>

            <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-amber-500/10">
              <AlertTriangle className="h-7 w-7 text-amber-500" />
            </div>

            <h2 className="text-xl font-semibold">Subscription expiring soon!</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Your subscription expires in{' '}
              <span className="font-semibold text-amber-500">
                {daysLeft} {daysLeft === 1 ? 'day' : 'days'}
              </span>
              . Please renew to avoid service interruption.
            </p>

            {amount > 0 && (
              <div className="my-5 rounded-xl border bg-muted/40 p-4">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Renewal amount</div>
                <div className="mt-1 text-2xl font-bold">{rupees(amount)}</div>
              </div>
            )}

            <div className="flex flex-col gap-3 mt-6">
              <Button size="lg" className="w-full" onClick={() => setLocked(true)}>
                <CreditCard className="mr-2 h-4 w-4" />
                Renew Now
              </Button>
              <button
                onClick={dismissReminder}
                className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground transition-colors"
              >
                OK, I will pay later
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
