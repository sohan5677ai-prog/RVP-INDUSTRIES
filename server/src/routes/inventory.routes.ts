import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  getStockByParty,
  getStockByState,
  getStockByPrice,
  getBlackSeedStock,
  getSilos,
} from '../controllers/inventory.controller.js';
import {
  listStockTransfers,
  createStockTransfer,
  deleteStockTransfer,
} from '../controllers/stockTransfer.controller.js';
import {
  listShellTransfers,
  createShellTransfer,
  deleteShellTransfer,
} from '../controllers/shellTransfer.controller.js';

const router = Router();

router.get('/inventory/black-seed', asyncHandler(getBlackSeedStock));
router.get('/inventory/by-party', asyncHandler(getStockByParty));
router.get('/inventory/by-state', asyncHandler(getStockByState));
router.get('/inventory/by-price', asyncHandler(getStockByPrice));
router.get('/inventory/silos', asyncHandler(getSilos));

router.get('/stock-transfers', asyncHandler(listStockTransfers));
router.post('/stock-transfers', asyncHandler(createStockTransfer));
router.delete('/stock-transfers/:id', asyncHandler(deleteStockTransfer));

router.get('/shell-transfers', asyncHandler(listShellTransfers));
router.post('/shell-transfers', asyncHandler(createShellTransfer));
router.delete('/shell-transfers/:id', asyncHandler(deleteShellTransfer));

export default router;
