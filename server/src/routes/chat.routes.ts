import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { chatLimiter } from '../middleware/rateLimit.js';
import { handleChat } from '../controllers/chat.controller.js';

const router = Router();

router.post('/', chatLimiter, asyncHandler(handleChat));

export default router;
