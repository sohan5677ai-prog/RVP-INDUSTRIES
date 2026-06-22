import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { listReceipts, createReceipt, deleteReceipt } from '../controllers/receipt.controller.js';

const router = Router();

router.get('/receipts', asyncHandler(listReceipts));
router.post('/receipts', asyncHandler(createReceipt));
router.delete('/receipts/:id', asyncHandler(deleteReceipt));

export default router;
