import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { chatLimiter } from '../middleware/rateLimit.js';
import { handleChat, getJarvisInsights } from '../controllers/chat.controller.js';

const router = Router();

router.post('/', chatLimiter, asyncHandler(handleChat));
router.get('/insights', asyncHandler(getJarvisInsights));

export default router;
