import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { memoryUpload, upload } from '../lib/upload.js';
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
// Multer only engages on multipart bodies, so plain-JSON creates still work.
// A 'screenshot' file is persisted and WhatsApp'd to the party as payment proof.
router.post('/payments', upload.single('screenshot'), asyncHandler(createPayment));
router.delete('/payments/:id', asyncHandler(deletePayment));

export default router;
