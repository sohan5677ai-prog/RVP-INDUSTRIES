import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { loginLimiter } from '../middleware/rateLimit.js';
import { login, kioskLogin, me, heartbeat, logout } from '../controllers/auth.controller.js';

const router = Router();

router.post('/login', loginLimiter, asyncHandler(login));
router.post('/kiosk', loginLimiter, asyncHandler(kioskLogin));
router.get('/me', requireAuth, asyncHandler(me));
router.post('/heartbeat', requireAuth, asyncHandler(heartbeat));
router.post('/logout', requireAuth, asyncHandler(logout));

export default router;
