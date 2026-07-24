// Thin wrapper over the Razorpay REST API. Deliberately no SDK — the rest of
// the subscription code uses built-in `fetch` + `crypto`, and we keep that
// convention so there's one less dependency to audit/update.
//
// Only the pieces needed for auto-recurring live here: creating a monthly Plan
// and creating a Subscription against it. One-time orders stay inline in
// subscription.routes.ts.

const RAZORPAY_API = 'https://api.razorpay.com/v1';

/** Error carrying the upstream HTTP status so callers can branch on 401 etc. */
export class RazorpayError extends Error {
  status: number;
  body?: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'RazorpayError';
    this.status = status;
    this.body = body;
  }
}

export function keys() {
  return {
    keyId: process.env.RAZORPAY_KEY_ID,
    keySecret: process.env.RAZORPAY_KEY_SECRET,
  };
}

export function isConfigured(): boolean {
  const { keyId, keySecret } = keys();
  return !!(keyId && keySecret);
}

interface RzpOptions {
  method?: string;
  body?: unknown;
}

/**
 * Basic-auth JSON call to Razorpay. Throws a RazorpayError tagged with the
 * upstream `.status` so callers can distinguish auth failures (401) from other
 * upstream errors.
 */
export async function rzp<T = any>(path: string, { method = 'GET', body }: RzpOptions = {}): Promise<T> {
  const { keyId, keySecret } = keys();
  if (!keyId || !keySecret) throw new RazorpayError('Razorpay is not configured', 503);

  const auth64 = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const res = await fetch(`${RAZORPAY_API}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${auth64}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new RazorpayError(
      data?.error?.description || `Razorpay ${path} failed (${res.status})`,
      res.status,
      data
    );
  }
  return data as T;
}

/**
 * Create a monthly plan for the given fee. Plan amounts are immutable in
 * Razorpay, so a new plan is minted whenever the fee changes; the caller caches
 * the id on the Subscription row and reuses it while the fee holds.
 */
export async function createMonthlyPlan(amountPaise: number) {
  return rzp('/plans', {
    method: 'POST',
    body: {
      period: 'monthly',
      interval: 1,
      item: {
        name: 'RVP Industries ERP — monthly licence',
        amount: amountPaise, // paise
        currency: 'INR',
      },
      notes: { purpose: 'RVP ERP monthly subscription' },
    },
  });
}

/**
 * Create a recurring subscription against a plan. No `start_at` → Razorpay
 * authorises and takes the first charge immediately, then bills monthly.
 * total_count is a large finite ceiling (Razorpay requires one); the mandate is
 * cancelled explicitly from the config screen well before it's reached.
 */
export async function createSubscription(planId: string) {
  return rzp('/subscriptions', {
    method: 'POST',
    body: {
      plan_id: planId,
      total_count: 120, // 10 years of monthly cycles
      customer_notify: 1,
      notes: { purpose: 'RVP ERP monthly subscription' },
    },
  });
}

export async function cancelSubscription(subId: string, cancelAtCycleEnd = false) {
  return rzp(`/subscriptions/${subId}/cancel`, {
    method: 'POST',
    body: { cancel_at_cycle_end: cancelAtCycleEnd ? 1 : 0 },
  });
}
