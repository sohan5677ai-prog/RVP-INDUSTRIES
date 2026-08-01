import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { upload, memoryUpload } from '../lib/upload.js';
import {
  listSaleOrders,
  getSaleOrder,
  createSaleOrder,
  bulkCreateSaleOrders,
  updateSaleOrder,
  deleteSaleOrder,
  extractSaleDoc,
  dispatchSaleOrder,
  getSaleDispatch,
  raiseSaleInvoice,
  previewSaleInvoiceNumber,
  deliverSaleDispatch,
  markDispatchPaid,
  undoSaleDispatch,
  saveLorryReceipt,
} from '../controllers/sale.controller.js';

const router = Router();

router.get('/sale-orders', asyncHandler(listSaleOrders));
router.get('/sale-orders/:id', asyncHandler(getSaleOrder));
router.post('/sale-orders/bulk', asyncHandler(bulkCreateSaleOrders));
router.post('/sale-orders', asyncHandler(createSaleOrder));
router.put('/sale-orders/:id', asyncHandler(updateSaleOrder));
router.delete('/sale-orders/:id', asyncHandler(deleteSaleOrder));

// Dispatch: read a doc for pre-fill (in-memory), then dispatch a (partial) lorry
// against the order with the kata slip - creates a SaleDispatch shipment.
router.post('/sale-orders/extract', memoryUpload.single('document'), asyncHandler(extractSaleDoc));
router.post(
  '/sale-orders/:id/dispatch',
  upload.fields([{ name: 'kata', maxCount: 1 }]),
  asyncHandler(dispatchSaleOrder)
);

// A single dispatch (shipment) - used by the invoice view.
router.get('/sale-dispatches/:id', asyncHandler(getSaleDispatch));

// Raise the tax invoice for a dispatched shipment (auto-assigns number). The
// invoice itself is rendered/printed client-side.
router.post('/sale-dispatches/:id/invoice', asyncHandler(raiseSaleInvoice));

// Peek at the number the invoice would take (no side effects) - drives the
// Tally-style preview shown before the invoice is raised.
router.get('/sale-dispatches/:id/invoice/preview', asyncHandler(previewSaleInvoiceNumber));

// Mark a dispatched shipment as delivered (DISPATCHED -> DELIVERED): records
// deliveredDate + buyer kata weight and settles any shortage credit note.
router.post(
  '/sale-dispatches/:id/deliver',
  upload.fields([{ name: 'kata', maxCount: 1 }]),
  asyncHandler(deliverSaleDispatch)
);

// Surya Road Lines lorry receipt (GC): the book number, its date and the packing
// lines typed on the printable copy. Rendered client-side like the invoice.
router.patch('/sale-dispatches/:id/lorry-receipt', asyncHandler(saveLorryReceipt));

// Mark a dispatched shipment as paid and record receipt/TDS
router.post('/sale-dispatches/:id/mark-paid', asyncHandler(markDispatchPaid));

// Undo a dispatch made by mistake (only while still a plain DISPATCHED record):
// restores inventory, deletes the sale posting + the shipment.
router.post('/sale-dispatches/:id/undo', asyncHandler(undoSaleDispatch));

export default router;
