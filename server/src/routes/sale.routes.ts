import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { upload } from '../lib/upload.js';
import {
  listSaleOrders,
  getSaleOrder,
  createSaleOrder,
  updateSaleOrder,
  deleteSaleOrder,
  createSaleDispatch,
  recordBuyerWeight,
} from '../controllers/sale.controller.js';

const router = Router();

router.get('/sale-orders', asyncHandler(listSaleOrders));
router.get('/sale-orders/:id', asyncHandler(getSaleOrder));
router.post('/sale-orders', asyncHandler(createSaleOrder));
router.put('/sale-orders/:id', asyncHandler(updateSaleOrder));
router.delete('/sale-orders/:id', asyncHandler(deleteSaleOrder));

router.post('/sale-dispatch', upload.single('invoice'), asyncHandler(createSaleDispatch));
router.post('/sale-dispatch/:id/buyer-weight', asyncHandler(recordBuyerWeight));

export default router;
