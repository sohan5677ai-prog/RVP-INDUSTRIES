import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { upload, memoryUpload } from '../lib/upload.js';
import {
  listSaleOrders,
  getSaleOrder,
  createSaleOrder,
  updateSaleOrder,
  deleteSaleOrder,
  advanceSaleStatus,
  extractSaleDoc,
  dispatchSaleOrder,
  raiseSaleInvoice,
  deliverSaleOrder,
} from '../controllers/sale.controller.js';

const router = Router();

router.get('/sale-orders', asyncHandler(listSaleOrders));
router.get('/sale-orders/:id', asyncHandler(getSaleOrder));
router.post('/sale-orders', asyncHandler(createSaleOrder));
router.put('/sale-orders/:id', asyncHandler(updateSaleOrder));
router.delete('/sale-orders/:id', asyncHandler(deleteSaleOrder));
router.post(
  '/sale-orders/:id/advance',
  upload.fields([{ name: 'kata', maxCount: 1 }]),
  asyncHandler(advanceSaleStatus)
);

// Dispatch: read a doc for pre-fill (in-memory), then dispatch with the kata slip.
router.post('/sale-orders/extract', memoryUpload.single('document'), asyncHandler(extractSaleDoc));
router.post(
  '/sale-orders/:id/dispatch',
  upload.fields([{ name: 'kata', maxCount: 1 }]),
  asyncHandler(dispatchSaleOrder)
);

// Raise the tax invoice for a dispatched order (auto-assigns number). The invoice
// itself is rendered/printed client-side.
router.post('/sale-orders/:id/invoice', asyncHandler(raiseSaleInvoice));

// Mark a reached order as delivered (REACHED -> DELIVERED). Records deliveredDate.
router.post(
  '/sale-orders/:id/deliver',
  upload.fields([{ name: 'kata', maxCount: 1 }]),
  asyncHandler(deliverSaleOrder)
);

export default router;
