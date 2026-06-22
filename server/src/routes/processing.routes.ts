import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  listProcessing,
  createProcessing,
  updateProcessing,
  deleteProcessing,
} from '../controllers/processing.controller.js';

const router = Router();

router.get('/processing', asyncHandler(listProcessing));
router.post('/processing', asyncHandler(createProcessing));
router.put('/processing/:id', asyncHandler(updateProcessing));
router.delete('/processing/:id', asyncHandler(deleteProcessing));

export default router;
