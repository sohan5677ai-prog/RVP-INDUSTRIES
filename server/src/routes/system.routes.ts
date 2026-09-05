import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireRole } from '../middleware/auth.js';
import {
  clearTransactions,
  getMaintenanceStatusHandler,
  getMaintenanceConfigHandler,
  updateMaintenanceConfigHandler,
  extendMaintenanceHandler,
  endMaintenanceHandler,
} from '../controllers/system.controller.js';

const router = Router();

// Publicly readable maintenance status & timer (also mounted before global requireAuth in index.ts)
router.get('/maintenance/status', asyncHandler(getMaintenanceStatusHandler));

// Developer-only maintenance controls & configuration
router.get('/maintenance/config', requireRole('DEVELOPER'), asyncHandler(getMaintenanceConfigHandler));
router.post('/maintenance/config', requireRole('DEVELOPER'), asyncHandler(updateMaintenanceConfigHandler));
router.post('/maintenance/extend', requireRole('DEVELOPER'), asyncHandler(extendMaintenanceHandler));
router.post('/maintenance/end', requireRole('DEVELOPER'), asyncHandler(endMaintenanceHandler));

router.post('/clear-transactions', requireRole('DEVELOPER'), asyncHandler(clearTransactions));

export default router;
