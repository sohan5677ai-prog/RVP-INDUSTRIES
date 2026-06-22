import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { listPayments, createPayment, deletePayment } from '../controllers/payment.controller.js';

const router = Router();

router.get('/payments', asyncHandler(listPayments));
router.post('/payments', asyncHandler(createPayment));
router.delete('/payments/:id', asyncHandler(deletePayment));

export default router;
