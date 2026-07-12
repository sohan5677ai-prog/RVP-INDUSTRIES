import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { loginLimiter } from '../middleware/rateLimit.js';
import { login, me } from '../controllers/auth.controller.js';

const router = Router();

router.post('/login', loginLimiter, asyncHandler(login));
router.get('/me', requireAuth, asyncHandler(me));

export default router;
