import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getGstReport, getTdsReport, getGstr1Report } from '../controllers/report.controller.js';

const router = Router();

router.get('/reports/gst', asyncHandler(getGstReport));
router.get('/reports/tds', asyncHandler(getTdsReport));
router.get('/reports/gstr1', asyncHandler(getGstr1Report));

export default router;
