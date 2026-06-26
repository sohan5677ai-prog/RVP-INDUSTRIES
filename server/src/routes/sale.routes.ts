import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { upload, memoryUpload } from '../lib/upload.js';
import {
  listSaleOrders,
  getSaleOrder,
  createSaleOrder,
  updateSaleOrder,
  deleteSaleOrder,
  extractSaleDoc,
  dispatchSaleOrder,
  getSaleDispatch,
  raiseSaleInvoice,
  deliverSaleDispatch,
} from '../controllers/sale.controller.js';

const router = Router();

router.get('/sale-orders', asyncHandler(listSaleOrders));
router.get('/sale-orders/:id', asyncHandler(getSaleOrder));
router.post('/sale-orders', asyncHandler(createSaleOrder));
router.put('/sale-orders/:id', asyncHandler(updateSaleOrder));
router.delete('/sale-orders/:id', asyncHandler(deleteSaleOrder));

// Dispatch: read a doc for pre-fill (in-memory), then dispatch a (partial) lorry
// against the order with the kata slip — creates a SaleDispatch shipment.
router.post('/sale-orders/extract', memoryUpload.single('document'), asyncHandler(extractSaleDoc));
router.post(
  '/sale-orders/:id/dispatch',
  upload.fields([{ name: 'kata', maxCount: 1 }]),
  asyncHandler(dispatchSaleOrder)
);

// A single dispatch (shipment) — used by the invoice view.
router.get('/sale-dispatches/:id', asyncHandler(getSaleDispatch));

// Raise the tax invoice for a dispatched shipment (auto-assigns number). The
// invoice itself is rendered/printed client-side.
router.post('/sale-dispatches/:id/invoice', asyncHandler(raiseSaleInvoice));

// Mark a dispatched shipment as delivered (DISPATCHED -> DELIVERED): records
// deliveredDate + buyer kata weight and settles any shortage credit note.
router.post(
  '/sale-dispatches/:id/deliver',
  upload.fields([{ name: 'kata', maxCount: 1 }]),
  asyncHandler(deliverSaleDispatch)
);

export default router;
