import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { memoryUpload } from '../lib/upload.js';
import {
  listPayments,
  createPayment,
  deletePayment,
  extractPaymentScreenshot,
} from '../controllers/payment.controller.js';

const router = Router();

router.get('/payments', asyncHandler(listPayments));
// Read a payment screenshot for pre-fill (in-memory, not persisted).
router.post('/payments/extract', memoryUpload.single('screenshot'), asyncHandler(extractPaymentScreenshot));
router.post('/payments', asyncHandler(createPayment));
router.delete('/payments/:id', asyncHandler(deletePayment));

export default router;
