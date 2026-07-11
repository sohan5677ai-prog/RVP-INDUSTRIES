import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  listManualHamaliCosts,
  createManualHamaliCost,
  deleteManualHamaliCost,
} from '../controllers/manualHamaliCost.controller.js';

const router = Router();

router.get('/manual-hamali-costs', asyncHandler(listManualHamaliCosts));
router.post('/manual-hamali-costs', asyncHandler(createManualHamaliCost));
router.delete('/manual-hamali-costs/:id', asyncHandler(deleteManualHamaliCost));

export default router;
