import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { listEmailLogs, getEmailLogStats, resendEmailLog } from '../controllers/emailLog.controller.js';

const router = Router();

router.get('/email-logs', asyncHandler(listEmailLogs));
router.get('/email-logs/stats', asyncHandler(getEmailLogStats));
router.post('/email-logs/:id/resend', asyncHandler(resendEmailLog));

export default router;
