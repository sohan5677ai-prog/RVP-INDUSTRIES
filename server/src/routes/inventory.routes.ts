import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  getStockByParty,
  getStockByState,
  getBlackSeedStock,
} from '../controllers/inventory.controller.js';

const router = Router();

router.get('/inventory/black-seed', asyncHandler(getBlackSeedStock));
router.get('/inventory/by-party', asyncHandler(getStockByParty));
router.get('/inventory/by-state', asyncHandler(getStockByState));

export default router;
