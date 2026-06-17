import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  listProcessing,
  createProcessing,
  updateProcessing,
  deleteProcessing,
  createPappuPrice,
  updatePappuPrice,
  deletePappuPrice,
} from '../controllers/processing.controller.js';

const router = Router();

router.get('/processing', asyncHandler(listProcessing));
router.post('/processing', asyncHandler(createProcessing));
router.put('/processing/:id', asyncHandler(updateProcessing));
router.delete('/processing/:id', asyncHandler(deleteProcessing));

router.post('/pappu-prices', asyncHandler(createPappuPrice));
router.put('/pappu-prices/:id', asyncHandler(updatePappuPrice));
router.delete('/pappu-prices/:id', asyncHandler(deletePappuPrice));

export default router;
