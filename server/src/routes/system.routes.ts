import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { clearTransactions } from '../controllers/system.controller.js';

const router = Router();

router.post('/clear-transactions', asyncHandler(clearTransactions));

export default router;
