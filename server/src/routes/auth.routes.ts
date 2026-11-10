import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { loginLimiter, passwordResetLimiter } from '../middleware/rateLimit.js';
import {
  login,
  verifyMfa,
  refresh,
  kioskLogin,
  me,
  heartbeat,
  logout,
  logoutEverywhere,
  changePassword,
  forgotPassword,
  resetPassword,
  beginMfaEnrolment,
  confirmMfaEnrolment,
  disableMfa,
} from '../controllers/auth.controller.js';

const router = Router();

// Public, and rate-limited: every one of these takes an unauthenticated guess
// at a credential.
router.post('/login', loginLimiter, asyncHandler(login));
router.post('/mfa/verify', loginLimiter, asyncHandler(verifyMfa));
router.post('/kiosk', loginLimiter, asyncHandler(kioskLogin));
// Not under loginLimiter: a legitimate client refreshes every 15 minutes and
// would eventually trip a bucket sized for guessing attempts. The refresh
// token itself is the control, and replaying a rotated one kills the session.
router.post('/refresh', asyncHandler(refresh));

// Public but tightly limited - these send email, so an open endpoint is both an
// account-existence oracle and a way to use the ERP as a mail relay.
router.post('/forgot-password', passwordResetLimiter, asyncHandler(forgotPassword));
router.post('/reset-password', passwordResetLimiter, asyncHandler(resetPassword));

// Authenticated.
router.get('/me', requireAuth, asyncHandler(me));
router.post('/heartbeat', requireAuth, asyncHandler(heartbeat));
router.post('/logout', requireAuth, asyncHandler(logout));
router.post('/logout-all', requireAuth, asyncHandler(logoutEverywhere));
router.post('/change-password', requireAuth, asyncHandler(changePassword));
router.post('/mfa/enrol', requireAuth, asyncHandler(beginMfaEnrolment));
router.post('/mfa/enrol/confirm', requireAuth, asyncHandler(confirmMfaEnrolment));
router.post('/mfa/disable', requireAuth, asyncHandler(disableMfa));

export default router;
