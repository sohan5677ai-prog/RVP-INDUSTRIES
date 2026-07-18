import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { listEmailLogs, resendEmailLog } from '../controllers/emailLog.controller.js';

const router = Router();

router.get('/email-logs', asyncHandler(listEmailLogs));
router.post('/email-logs/:id/resend', asyncHandler(resendEmailLog));

export default router;
