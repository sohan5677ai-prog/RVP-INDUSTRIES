import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  listSecurityAlerts,
  acknowledgeSecurityAlert,
  securityOverview,
  runSecurityChecks,
} from '../controllers/security.controller.js';

const router = Router();

router.get('/alerts', asyncHandler(listSecurityAlerts));
router.get('/overview', asyncHandler(securityOverview));
// Acknowledging and running the checks are writes; the permission table puts
// them behind system.manage while reading needs only audit.view.
router.post('/alerts/:id/acknowledge', asyncHandler(acknowledgeSecurityAlert));
router.post('/run', asyncHandler(runSecurityChecks));

export default router;
