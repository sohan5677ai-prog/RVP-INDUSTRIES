import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { dashboardSummary, dashboardCharts, huskPnl } from '../controllers/dashboard.controller.js';

const router = Router();

router.get('/dashboard/summary', asyncHandler(dashboardSummary));
router.get('/dashboard/charts', asyncHandler(dashboardCharts));
router.get('/reports/husk-pnl', asyncHandler(huskPnl));

export default router;
