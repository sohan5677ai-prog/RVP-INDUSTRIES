import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  listAuditLog,
  verifyAuditLog,
  listPeriodLocks,
  createPeriodLock,
  releasePeriodLock,
} from '../controllers/audit.controller.js';

const router = Router();

// Authorization comes from the route permission table: /audit-log* and
// /period-locks* both need audit.view / system.manage respectively.
router.get('/audit-log', asyncHandler(listAuditLog));
router.post('/audit-log/verify', asyncHandler(verifyAuditLog));

router.get('/period-locks', asyncHandler(listPeriodLocks));
router.post('/period-locks', asyncHandler(createPeriodLock));
router.post('/period-locks/:id/release', asyncHandler(releasePeriodLock));

export default router;
