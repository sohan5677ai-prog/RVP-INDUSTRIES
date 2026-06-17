import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { upload, memoryUpload } from '../lib/upload.js';
import {
  listPurchaseOrders,
  getPurchaseOrder,
  createPurchaseOrder,
  updatePurchaseOrder,
  deletePurchaseOrder,
} from '../controllers/purchaseOrder.controller.js';
import {
  createStockIn,
  getStockIn,
  listStockIns,
  updateStockIn,
  deleteStockIn,
  extractStockInInvoice,
} from '../controllers/stockIn.controller.js';
import {
  createPurchase,
  getPurchase,
  listPurchases,
  updatePurchase,
  deletePurchase,
} from '../controllers/purchase.controller.js';
import {
  listVerifications,
  getVerification,
  createVerification,
  deleteVerification,
} from '../controllers/verification.controller.js';

const router = Router();

// Purchase orders
router.get('/purchase-orders', asyncHandler(listPurchaseOrders));
router.get('/purchase-orders/:id', asyncHandler(getPurchaseOrder));
router.post('/purchase-orders', asyncHandler(createPurchaseOrder));
router.put('/purchase-orders/:id', asyncHandler(updatePurchaseOrder));
router.delete('/purchase-orders/:id', asyncHandler(deletePurchaseOrder));

// Stock-in (multipart invoice upload)
router.post('/stock-in/extract', memoryUpload.single('invoice'), asyncHandler(extractStockInInvoice));
router.get('/stock-in', asyncHandler(listStockIns));
router.get('/stock-in/:id', asyncHandler(getStockIn));
router.post('/stock-in', upload.single('invoice'), asyncHandler(createStockIn));
router.put('/stock-in/:id', upload.single('invoice'), asyncHandler(updateStockIn));
router.delete('/stock-in/:id', asyncHandler(deleteStockIn));

// Purchase
router.get('/purchases', asyncHandler(listPurchases));
router.get('/purchases/:id', asyncHandler(getPurchase));
router.post('/purchases', asyncHandler(createPurchase));
router.put('/purchases/:id', asyncHandler(updatePurchase));
router.delete('/purchases/:id', asyncHandler(deletePurchase));

// Weight verification (separate step from recording a purchase)
router.get('/verifications', asyncHandler(listVerifications));
router.get('/verifications/:id', asyncHandler(getVerification));
router.post('/verifications', asyncHandler(createVerification));
router.delete('/verifications/:id', asyncHandler(deleteVerification));

export default router;
