import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  getStockByParty,
  getStockByState,
  getStockByPrice,
  getBlackSeedStock,
  getSilos,
  getCalculatorDefaults,
  getPappuOrderMargins,
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
import {
  listDustPurchases,
  createDustPurchase,
  deleteDustPurchase,
} from '../controllers/dustPurchase.controller.js';
import {
  listHuskTransfers,
  createHuskTransfer,
  deleteHuskTransfer,
} from '../controllers/huskTransfer.controller.js';

const router = Router();

router.get('/inventory/black-seed', asyncHandler(getBlackSeedStock));
router.get('/inventory/by-party', asyncHandler(getStockByParty));
router.get('/inventory/by-state', asyncHandler(getStockByState));
router.get('/inventory/by-price', asyncHandler(getStockByPrice));
router.get('/inventory/pappu-margins', asyncHandler(getPappuOrderMargins));
router.get('/inventory/silos', asyncHandler(getSilos));
router.get('/inventory/calculator-defaults', asyncHandler(getCalculatorDefaults));

router.get('/stock-transfers', asyncHandler(listStockTransfers));
router.post('/stock-transfers', asyncHandler(createStockTransfer));
router.delete('/stock-transfers/:id', asyncHandler(deleteStockTransfer));

router.get('/shell-transfers', asyncHandler(listShellTransfers));
router.post('/shell-transfers', asyncHandler(createShellTransfer));
router.delete('/shell-transfers/:id', asyncHandler(deleteShellTransfer));

router.get('/husk-transfers', asyncHandler(listHuskTransfers));
router.post('/husk-transfers', asyncHandler(createHuskTransfer));
router.delete('/husk-transfers/:id', asyncHandler(deleteHuskTransfer));

router.get('/dust-purchases', asyncHandler(listDustPurchases));
router.post('/dust-purchases', asyncHandler(createDustPurchase));
router.delete('/dust-purchases/:id', asyncHandler(deleteDustPurchase));

export default router;
