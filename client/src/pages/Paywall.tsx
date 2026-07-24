// Full-screen lock shown when the monthly subscription is expired. This is
// only the visible layer — the backend already rejects every protected API
// call with 402, so the app is genuinely unusable until a verified Razorpay
// payment (or a developer override) extends access.

import { useEffect, useState } from 'react';
import { Loader2, Lock, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, clearToken, getErrorMessage } from '@/lib/api';

const RZP_SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';

interface Status {
  amount: number;
  paidUntil: string | null;
}

// Load the Razorpay Checkout script once, on demand.
function loadRazorpay(): Promise<boolean> {
  return new Promise((resolve) => {
    if ((window as any).Razorpay) return resolve(true);
    const s = document.createElement('script');
    s.src = RZP_SCRIPT;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.body.appendChild(s);
  });
}

const rupees = (paise: number) =>
  `₹${((paise || 0) / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;

export default function Paywall() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<Status>('/subscription/status')
      .then(setStatus)
      .catch(() => setStatus({ amount: 0, paidUntil: null }));
  }, []);

  const logout = () => {
    clearToken();
    window.location.href = '/login';
  };

  // Open Razorpay Checkout for the one-time order, verify server-side, then
  // reload into the app. Checkout returns the order/payment ids to the handler,
  // which the /verify endpoint validates by signature.
  const openCheckout = (opts: { keyId: string; order_id: string; amount: number }, description: string) => {
    const rzp = new (window as any).Razorpay({
      key: opts.keyId,
      order_id: opts.order_id,
      amount: opts.amount,
      currency: 'INR',
      name: 'RVP Industries ERP',
      description,
      handler: async (response: unknown) => {
        try {
          await api('/subscription/verify', { method: 'POST', body: response });
          // Verified server-side — reload straight into the app.
          window.location.reload();
        } catch (e) {
          setError(getErrorMessage(e) || 'Payment could not be verified. Contact the vendor.');
          setLoading(false);
        }
      },
      modal: { ondismiss: () => setLoading(false) },
      theme: { color: '#d97706' },
    });
    rzp.on('payment.failed', () => {
      setError('Payment failed. Please try again.');
      setLoading(false);
    });
    rzp.open();
  };

  // Pay this month's fee (one-time).
  const pay = async () => {
    setError('');
    setLoading(true);
    try {
      const ok = await loadRazorpay();
      if (!ok) throw new Error('Could not load the payment window. Check your connection.');
      const order = await api<{ keyId: string; orderId: string; amount: number }>('/subscription/order', {
        method: 'POST',
      });
      openCheckout({ keyId: order.keyId, order_id: order.orderId, amount: order.amount }, 'Monthly subscription');
    } catch (e) {
      setError(getErrorMessage(e) || 'Could not start payment.');
      setLoading(false);
    }
  };

  const dueDate = status?.paidUntil
    ? new Date(status.paidUntil).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : null;

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background text-foreground p-4">
      <div className="w-full max-w-md rounded-2xl border bg-card/70 backdrop-blur-md p-8 shadow-xl text-center">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10">
          <Lock className="h-7 w-7 text-destructive" />
        </div>

        <h1 className="text-xl font-semibold">Subscription payment due</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your monthly access to RVP Industries ERP has expired. Please complete this month&apos;s payment to
          continue using the software.
        </p>

        <div className="my-6 rounded-xl border bg-muted/40 p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Amount due</div>
          <div className="mt-1 text-3xl font-bold">{status ? rupees(status.amount) : '…'}</div>
          {dueDate && <div className="mt-1 text-xs text-muted-foreground">Was due on {dueDate}</div>}
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
        )}

        <Button size="lg" className="w-full" onClick={pay} disabled={loading || !status?.amount}>
          {loading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Processing…
            </>
          ) : (
            <>Pay {status ? rupees(status.amount) : ''} now</>
          )}
        </Button>

        <div className="mt-4 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5" />
          Secure payment via Razorpay
        </div>

        <button
          onClick={logout}
          className="mt-6 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          Log out
        </button>
      </div>
    </div>
  );
}
