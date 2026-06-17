import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { dashboardSummary } from '../controllers/dashboard.controller.js';

const router = Router();

router.get('/dashboard/summary', asyncHandler(dashboardSummary));

export default router;
