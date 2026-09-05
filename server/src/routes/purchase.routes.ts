import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { upload, memoryUpload } from '../lib/upload.js';
import {
  listPurchaseOrders,
  getPurchaseOrder,
  createPurchaseOrder,
  bulkCreatePurchaseOrders,
  updatePurchaseOrder,
  deletePurchaseOrder,
  voidPurchaseOrder,
  unvoidPurchaseOrder,
} from '../controllers/purchaseOrder.controller.js';
import {
  listStockIns,
  getStockIn,
  createStockIn,
  createUrpStockIn,
  createColdStorageBatch,
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
  updatePurchaseFreightCosts,
} from '../controllers/purchase.controller.js';
import {
  listVerifications,
  getVerification,
  createVerification,
  deleteVerification,
} from '../controllers/verification.controller.js';
import { downloadPurchaseStatementPdf } from '../controllers/purchaseStatement.controller.js';

const router = Router();

// Purchase orders
router.get('/purchase-orders', asyncHandler(listPurchaseOrders));
router.get('/purchase-orders/:id', asyncHandler(getPurchaseOrder));
router.post('/purchase-orders/bulk', asyncHandler(bulkCreatePurchaseOrders));
router.post('/purchase-orders', asyncHandler(createPurchaseOrder));
router.put('/purchase-orders/:id', asyncHandler(updatePurchaseOrder));
router.delete('/purchase-orders/:id', asyncHandler(deletePurchaseOrder));
router.post('/purchase-orders/:id/void', asyncHandler(voidPurchaseOrder));
router.post('/purchase-orders/:id/unvoid', asyncHandler(unvoidPurchaseOrder));
router.post('/purchase-orders/:id/restore', asyncHandler(unvoidPurchaseOrder));

// Stock-in (multipart invoice upload)
router.post('/stock-in/extract', memoryUpload.single('invoice'), asyncHandler(extractStockInInvoice));
router.post('/stock-in/cold-storage-batch', asyncHandler(createColdStorageBatch));
router.get('/stock-in', asyncHandler(listStockIns));
router.get('/stock-in/:id', asyncHandler(getStockIn));
router.post('/stock-in', upload.single('invoice'), asyncHandler(createStockIn));
router.post('/stock-in/urp', upload.single('invoice'), asyncHandler(createUrpStockIn));
router.put('/stock-in/:id', upload.single('invoice'), asyncHandler(updateStockIn));
router.delete('/stock-in/:id', asyncHandler(deleteStockIn));

// Purchase
router.get('/purchases', asyncHandler(listPurchases));
router.get('/purchases/:id', asyncHandler(getPurchase));
router.post('/purchases', asyncHandler(createPurchase));
router.put('/purchases/:id', asyncHandler(updatePurchase));
router.delete('/purchases/:id', asyncHandler(deletePurchase));
router.patch('/purchases/:id/freight-costs', asyncHandler(updatePurchaseFreightCosts));

// Weight verification (separate step from recording a purchase)
router.get('/verifications', asyncHandler(listVerifications));
router.get('/verifications/:id', asyncHandler(getVerification));
router.get('/verifications/:id/statement.pdf', asyncHandler(downloadPurchaseStatementPdf));
router.post('/verifications', asyncHandler(createVerification));
router.delete('/verifications/:id', asyncHandler(deleteVerification));

export default router;
