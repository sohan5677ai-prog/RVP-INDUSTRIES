import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getGstReport, getTdsReport } from '../controllers/report.controller.js';

const router = Router();

router.get('/reports/gst', asyncHandler(getGstReport));
router.get('/reports/tds', asyncHandler(getTdsReport));

export default router;
