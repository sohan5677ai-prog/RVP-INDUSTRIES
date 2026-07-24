// Monthly SaaS licensing endpoints. Mounted at /api/subscription BEFORE the
// global subscription gate, so these keep working while the deployment is
// locked (otherwise the pay screen could never function).
//
// Payment flow (manual monthly Razorpay checkout):
//   1. client POST /order  -> we create a Razorpay order + a local
//      SubscriptionPayment(created) and return the public keyId.
//   2. client opens Razorpay Checkout, user pays.
//   3. client POST /verify with the ids Razorpay returns -> we verify the HMAC
//      signature SERVER-SIDE, then advance paidUntil.
//
// Payment success is NEVER trusted from the client: only a valid signature
// computed with RAZORPAY_KEY_SECRET extends access.

import { Router } from 'express';
import type { Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { HttpError } from '../lib/httpError.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  getSubscription,
  nextDueDate,
  statusPayload,
  daysLeft,
  advanceFrom,
} from '../services/subscription.service.js';
import * as rzpSvc from '../services/razorpay.service.js';

const router = Router();

const RAZORPAY_ORDERS_URL = 'https://api.razorpay.com/v1/orders';

function razorpayKeys() {
  return {
    keyId: process.env.RAZORPAY_KEY_ID,
    keySecret: process.env.RAZORPAY_KEY_SECRET,
  };
}

/** Constant-time compare of two hex strings (signatures). */
function safeEqual(a: string, b: string): boolean {
  return (
    typeof a === 'string' &&
    typeof b === 'string' &&
    a.length === b.length &&
    crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}

// -- Razorpay webhook (server-to-server, NOT browser-authenticated) ----------
// Razorpay POSTs here directly, so there is no Bearer token; trust comes solely
// from the x-razorpay-signature HMAC over the RAW request body, verified with
// the webhook's own signing secret (distinct from the API key secret). This is
// the source of truth for recurring charges — the browser handler is only a
// nicety for instant feedback. Declared first so it stays outside requireAuth.
router.post(
  '/webhook',
  asyncHandler(async (req: Request, res: Response) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) return res.status(503).json({ error: 'Webhook not configured' });

    const signature = req.headers['x-razorpay-signature'];
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!signature || !raw) return res.status(400).json({ error: 'Missing signature' });

    const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    if (!safeEqual(expected, String(signature))) {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const event = req.body?.event;
    const payload = req.body?.payload || {};

    switch (event) {
      case 'subscription.charged':
        await handleSubscriptionCharged(payload);
        break;
      case 'subscription.activated':
      case 'subscription.authenticated':
        await handleSubscriptionStatus(payload, event);
        break;
      case 'subscription.halted':
      case 'subscription.cancelled':
      case 'subscription.completed':
        await handleSubscriptionEnded(payload, event);
        break;
      case 'payment.captured':
        await handlePaymentCaptured(payload);
        break;
      default:
        break; // ignore other events
    }

    // 200 so Razorpay stops retrying handled/ignored events.
    res.json({ ok: true });
  })
);

// Everything below the webhook requires a valid token.
router.use(requireAuth);

// -- Current lock/status (any authenticated user) ----------------------------
// Drives the paywall screen. Deliberately ungated.
router.get(
  '/status',
  asyncHandler(async (_req: Request, res: Response) => {
    const sub = await getSubscription();
    res.json(statusPayload(sub));
  })
);

// -- Create a Razorpay order for this month's fee ----------------------------
router.post(
  '/order',
  asyncHandler(async (_req: Request, res: Response) => {
    const { keyId, keySecret } = razorpayKeys();
    if (!keyId || !keySecret) {
      return res.status(503).json({
        error: 'Online payment is not configured yet. Please contact the vendor.',
      });
    }

    const sub = await getSubscription();
    // Razorpay's minimum chargeable amount is 100 paise (₹1).
    if (!sub.monthlyAmount || sub.monthlyAmount < 100) {
      return res.status(400).json({ error: 'Subscription amount is not set. Contact the vendor.' });
    }

    const auth64 = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const rzpRes = await fetch(RAZORPAY_ORDERS_URL, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth64}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: sub.monthlyAmount, // paise
        currency: 'INR',
        receipt: `sub_${Date.now()}`,
        notes: { purpose: 'RVP ERP monthly subscription' },
      }),
    });

    const order: any = await rzpRes.json();
    if (!rzpRes.ok || !order.id) {
      logger.error('Razorpay order failed:', order);
      if (rzpRes.status === 401) {
        return res.status(401).json({ error: 'Payment gateway authentication failed.' });
      }
      return res.status(502).json({ error: 'Could not start payment. Please try again.' });
    }

    await prisma.subscriptionPayment.create({
      data: { razorpayOrderId: order.id, amount: sub.monthlyAmount, status: 'created' },
    });

    res.json({ orderId: order.id, amount: sub.monthlyAmount, currency: 'INR', keyId });
  })
);

// -- Set up an auto-recurring subscription -----------------------------------
// Mints a fresh monthly plan for the current fee and a Razorpay subscription
// against it, then returns the subscription id for Checkout. A new plan each
// time avoids any stale-amount mismatch (plan amounts are immutable).
router.post(
  '/subscribe',
  asyncHandler(async (_req: Request, res: Response) => {
    if (!rzpSvc.isConfigured()) {
      return res.status(503).json({
        error: 'Online payment is not configured yet. Please contact the vendor.',
      });
    }

    const sub = await getSubscription();
    if (!sub.monthlyAmount || sub.monthlyAmount < 100) {
      return res.status(400).json({ error: 'Subscription amount is not set. Contact the vendor.' });
    }

    try {
      const plan: any = await rzpSvc.createMonthlyPlan(sub.monthlyAmount);
      const subscription: any = await rzpSvc.createSubscription(plan.id);

      await prisma.subscription.update({
        where: { id: sub.id },
        data: {
          razorpayPlanId: plan.id,
          razorpaySubId: subscription.id,
          subStatus: subscription.status || 'created',
        },
      });

      const { keyId } = rzpSvc.keys();
      res.json({ subscriptionId: subscription.id, keyId });
    } catch (err) {
      const status = (err as rzpSvc.RazorpayError)?.status;
      if (status === 401) {
        return res.status(401).json({ error: 'Payment gateway authentication failed.' });
      }
      logger.error('subscribe error:', err);
      res
        .status(status && status < 500 ? status : 502)
        .json({ error: (err as Error)?.message || 'Could not start the subscription.' });
    }
  })
);

// -- Verify a completed payment and extend access ----------------------------
router.post(
  '/verify',
  asyncHandler(async (req: Request, res: Response) => {
    const { keySecret } = razorpayKeys();
    if (!keySecret) return res.status(503).json({ error: 'Payment not configured.' });

    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      razorpay_subscription_id,
    } = req.body || {};

    // -- Recurring subscription authorisation ---------------------------------
    // Checkout for a subscription returns a subscription id (not an order id)
    // and a signature over `payment_id|subscription_id`.
    if (razorpay_subscription_id) {
      if (!razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ error: 'Missing payment details' });
      }

      const expected = crypto
        .createHmac('sha256', keySecret)
        .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
        .digest('hex');
      if (!safeEqual(expected, razorpay_signature)) {
        return res.status(400).json({ error: 'Payment verification failed' });
      }

      const sub = await getSubscription();
      if (sub.razorpaySubId && sub.razorpaySubId !== razorpay_subscription_id) {
        return res.status(400).json({ error: 'Unknown subscription' });
      }

      // The matching `subscription.charged` webhook may already have recorded
      // this first charge. Advance access only if it hasn't (idempotent by
      // payment id), so the two paths never double-count.
      const already = await prisma.subscriptionPayment.findFirst({
        where: { razorpayPaymentId: razorpay_payment_id, status: 'paid' },
      });

      if (already) {
        await prisma.subscription.update({
          where: { id: sub.id },
          data: { razorpaySubId: razorpay_subscription_id, subStatus: 'active' },
        });
      } else {
        const periodEnd = advanceFrom(sub);
        await prisma.$transaction([
          prisma.subscriptionPayment.create({
            data: {
              razorpaySubId: razorpay_subscription_id,
              razorpayPaymentId: razorpay_payment_id,
              source: 'recurring',
              amount: sub.monthlyAmount,
              status: 'paid',
              periodEnd,
            },
          }),
          prisma.subscription.update({
            where: { id: sub.id },
            // A verified payment always restores access: advance the paid-through
            // date and lift any manual "stop services" hold.
            data: {
              paidUntil: periodEnd,
              lastPaymentId: razorpay_payment_id,
              razorpaySubId: razorpay_subscription_id,
              subStatus: 'active',
              servicesStopped: false,
            },
          }),
        ]);
      }

      const updated = await getSubscription();
      return res.json(statusPayload(updated));
    }

    // -- Manual one-time order ------------------------------------------------
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment details' });
    }

    const payment = await prisma.subscriptionPayment.findUnique({
      where: { razorpayOrderId: razorpay_order_id },
    });
    if (!payment) return res.status(400).json({ error: 'Unknown order' });
    if (payment.status === 'paid') {
      const sub = await getSubscription();
      return res.json(statusPayload(sub));
    }

    const expected = crypto
      .createHmac('sha256', keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (!safeEqual(expected, razorpay_signature)) {
      await prisma.subscriptionPayment.update({
        where: { id: payment.id },
        data: { status: 'failed', razorpayPaymentId: razorpay_payment_id },
      });
      return res.status(400).json({ error: 'Payment verification failed' });
    }

    // Signature valid → advance the paid-through date by one billing cycle.
    const sub = await getSubscription();
    const periodEnd = advanceFrom(sub);

    await prisma.$transaction([
      prisma.subscriptionPayment.update({
        where: { id: payment.id },
        data: { status: 'paid', razorpayPaymentId: razorpay_payment_id, periodEnd },
      }),
      prisma.subscription.update({
        where: { id: sub.id },
        data: { paidUntil: periodEnd, lastPaymentId: razorpay_payment_id, servicesStopped: false },
      }),
    ]);

    const updated = await getSubscription();
    res.json(statusPayload(updated));
  })
);

// -- Developer-only: payment history -----------------------------------------
router.get(
  '/payments',
  requireRole('DEVELOPER'),
  asyncHandler(async (_req: Request, res: Response) => {
    const payments = await prisma.subscriptionPayment.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        razorpayOrderId: true,
        razorpayPaymentId: true,
        razorpaySubId: true,
        invoiceId: true,
        source: true,
        amount: true,
        status: true,
        periodEnd: true,
        createdAt: true,
      },
    });
    res.json(payments);
  })
);

// -- Developer-only: config --------------------------------------------------
router.get(
  '/config',
  requireRole('DEVELOPER'),
  asyncHandler(async (_req: Request, res: Response) => {
    const sub = await getSubscription();
    res.json({
      active: sub.active,
      servicesStopped: sub.servicesStopped,
      monthlyAmount: sub.monthlyAmount, // paise
      billingDay: sub.billingDay,
      paidUntil: sub.paidUntil,
      daysLeft: daysLeft(sub),
      lastPaymentId: sub.lastPaymentId,
      subStatus: sub.subStatus || null,
      autopay:
        !!sub.razorpaySubId &&
        ['created', 'authenticated', 'active', 'pending'].includes(sub.subStatus || ''),
      razorpayConfigured: !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
      webhookConfigured: !!process.env.RAZORPAY_WEBHOOK_SECRET,
    });
  })
);

router.put(
  '/config',
  requireRole('DEVELOPER'),
  asyncHandler(async (req: Request, res: Response) => {
    const { active, servicesStopped, monthlyAmount, billingDay, paidUntil, markPaidNow } =
      req.body || {};

    const data: Record<string, unknown> = {};

    if (active !== undefined) data.active = !!active;

    // Developer kill switch. Setting it true locks users & admins instantly
    // (see isLocked); setting it false resumes them with paidUntil intact.
    if (servicesStopped !== undefined) data.servicesStopped = !!servicesStopped;

    if (monthlyAmount !== undefined) {
      const amt = parseInt(monthlyAmount, 10);
      if (isNaN(amt) || amt < 0) throw new HttpError(400, 'Invalid amount');
      data.monthlyAmount = amt; // caller sends paise
    }

    if (billingDay !== undefined) {
      const day = parseInt(billingDay, 10);
      if (isNaN(day) || day < 1 || day > 28) {
        throw new HttpError(400, 'Billing day must be between 1 and 28');
      }
      data.billingDay = day;
    }

    // Manual override: record an offline/cash payment or grant a free period by
    // pushing paidUntil forward without going through Razorpay.
    if (markPaidNow) {
      const sub = await getSubscription();
      data.paidUntil = nextDueDate(
        sub.paidUntil && new Date(sub.paidUntil) > new Date() ? new Date(sub.paidUntil) : new Date(),
        (data.billingDay as number) ?? sub.billingDay
      );
    } else if (paidUntil !== undefined) {
      data.paidUntil = paidUntil ? new Date(paidUntil) : null;
    }

    const current = await getSubscription();
    await prisma.subscription.update({ where: { id: current.id }, data });

    const updated = await getSubscription();
    res.json({
      active: updated.active,
      servicesStopped: updated.servicesStopped,
      monthlyAmount: updated.monthlyAmount,
      billingDay: updated.billingDay,
      paidUntil: updated.paidUntil,
      daysLeft: daysLeft(updated),
      lastPaymentId: updated.lastPaymentId,
    });
  })
);

// -- Developer-only: cancel the auto-recurring mandate -----------------------
router.post(
  '/cancel',
  requireRole('DEVELOPER'),
  asyncHandler(async (_req: Request, res: Response) => {
    const sub = await getSubscription();
    if (!sub.razorpaySubId) {
      return res.status(400).json({ error: 'No active auto-pay subscription.' });
    }
    if (rzpSvc.isConfigured()) {
      try {
        await rzpSvc.cancelSubscription(sub.razorpaySubId, false);
      } catch (e) {
        // Cancel locally even if Razorpay rejects (e.g. already cancelled).
        logger.error('razorpay cancel failed:', e);
      }
    }
    // paidUntil is left intact — they keep the access already paid for.
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { subStatus: 'cancelled', razorpaySubId: null },
    });
    const updated = await getSubscription();
    res.json(statusPayload(updated));
  })
);

// -- Webhook handlers --------------------------------------------------------

// A recurring cycle was charged: advance access one billing cycle. Idempotent
// by invoice id AND payment id so a retried webhook — or the browser's
// auth-time /verify — never advances twice.
async function handleSubscriptionCharged(payload: any) {
  const subEntity = payload.subscription?.entity;
  const paymentEntity = payload.payment?.entity;
  const razorpaySubId = subEntity?.id || paymentEntity?.subscription_id || null;
  const paymentId = paymentEntity?.id || null;
  const invoiceId = paymentEntity?.invoice_id || payload.invoice?.entity?.id || null;

  const sub = await getSubscription();
  if (razorpaySubId && sub.razorpaySubId && razorpaySubId !== sub.razorpaySubId) return;

  const dupOr = [
    invoiceId ? { invoiceId } : null,
    paymentId ? { razorpayPaymentId: paymentId } : null,
  ].filter(Boolean) as { invoiceId?: string; razorpayPaymentId?: string }[];
  const already =
    dupOr.length > 0 &&
    (await prisma.subscriptionPayment.findFirst({ where: { OR: dupOr, status: 'paid' } }));

  if (already) {
    await prisma.subscription.update({ where: { id: sub.id }, data: { subStatus: 'active' } });
    return;
  }

  const periodEnd = advanceFrom(sub);
  await prisma.$transaction([
    prisma.subscriptionPayment.create({
      data: {
        razorpaySubId,
        razorpayPaymentId: paymentId,
        invoiceId,
        source: 'recurring',
        amount: paymentEntity?.amount ?? sub.monthlyAmount,
        status: 'paid',
        periodEnd,
      },
    }),
    prisma.subscription.update({
      where: { id: sub.id },
      data: {
        paidUntil: periodEnd,
        lastPaymentId: paymentId,
        subStatus: 'active',
        razorpaySubId: razorpaySubId || sub.razorpaySubId,
        servicesStopped: false, // a successful charge restores service
      },
    }),
  ]);
}

// Mirror a lifecycle status change onto the singleton (no access change:
// access lapses naturally when paidUntil passes if charges stop).
async function handleSubscriptionStatus(payload: any, event: string) {
  const razorpaySubId = payload.subscription?.entity?.id;
  const sub = await getSubscription();
  if (razorpaySubId && sub.razorpaySubId && razorpaySubId !== sub.razorpaySubId) return;
  await prisma.subscription.update({
    where: { id: sub.id },
    data: { subStatus: event === 'subscription.activated' ? 'active' : 'authenticated' },
  });
}

async function handleSubscriptionEnded(payload: any, event: string) {
  const razorpaySubId = payload.subscription?.entity?.id;
  const sub = await getSubscription();
  if (razorpaySubId && sub.razorpaySubId && razorpaySubId !== sub.razorpaySubId) return;
  const statusMap: Record<string, string> = {
    'subscription.halted': 'halted',
    'subscription.cancelled': 'cancelled',
    'subscription.completed': 'completed',
  };
  await prisma.subscription.update({
    where: { id: sub.id },
    data: { subStatus: statusMap[event] || sub.subStatus },
  });
}

// Safety net for the MANUAL one-time flow: if the browser closed before POST
// /verify ran, this confirms the payment server-side. No-op for subscription
// charges (those arrive via subscription.charged) and idempotent with /verify.
async function handlePaymentCaptured(payload: any) {
  const paymentEntity = payload.payment?.entity;
  const orderId = paymentEntity?.order_id;
  const paymentId = paymentEntity?.id;
  if (!orderId) return; // recurring charge — handled elsewhere

  const payment = await prisma.subscriptionPayment.findUnique({
    where: { razorpayOrderId: orderId },
  });
  if (!payment || payment.status === 'paid') return;

  const sub = await getSubscription();
  const periodEnd = advanceFrom(sub);
  await prisma.$transaction([
    prisma.subscriptionPayment.update({
      where: { id: payment.id },
      data: { status: 'paid', razorpayPaymentId: paymentId, periodEnd },
    }),
    prisma.subscription.update({
      where: { id: sub.id },
      data: { paidUntil: periodEnd, lastPaymentId: paymentId, servicesStopped: false },
    }),
  ]);
}

export default router;
