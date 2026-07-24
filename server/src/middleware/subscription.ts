// The REAL licensing gate. Mounted after requireAuth and before the protected
// routers, so req.user is already populated. A frontend-only paywall is
// trivially bypassable (edit localStorage / call the API directly), so
// enforcement must live here: when the subscription is expired every protected
// call is rejected with 402.
//
// - The DEVELOPER role (the vendor) always bypasses, so they can still get in
//   to manage settings even while the deployment is locked.
// - /auth, /subscription and /health are mounted BEFORE this gate, so the login
//   and pay screens keep working while locked — they never reach here.

import type { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger.js';
import { getSubscription, isLocked } from '../services/subscription.service.js';

export async function subscriptionGate(req: Request, res: Response, next: NextFunction) {
  // The vendor is never locked out of their own deployment.
  if (req.user?.role === 'DEVELOPER') return next();

  try {
    const sub = await getSubscription();
    if (isLocked(sub)) {
      return res.status(402).json({
        code: 'SUBSCRIPTION_EXPIRED',
        error: 'Monthly subscription payment is due.',
      });
    }
  } catch (err) {
    // Never hard-fail the whole API because the gate check errored — fall
    // through and let the request proceed (fail open). The gate is a business
    // lock, not a security boundary.
    logger.error('subscriptionGate error:', err);
  }

  next();
}
