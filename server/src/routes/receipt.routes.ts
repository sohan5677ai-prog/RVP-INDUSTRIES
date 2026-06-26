import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { memoryUpload } from '../lib/upload.js';
import {
  listReceipts,
  createReceipt,
  deleteReceipt,
  extractReceiptScreenshot,
} from '../controllers/receipt.controller.js';

const router = Router();

router.get('/receipts', asyncHandler(listReceipts));
// Read a receipt screenshot for pre-fill (in-memory, not persisted).
router.post('/receipts/extract', memoryUpload.single('screenshot'), asyncHandler(extractReceiptScreenshot));
router.post('/receipts', asyncHandler(createReceipt));
router.delete('/receipts/:id', asyncHandler(deleteReceipt));

export default router;
