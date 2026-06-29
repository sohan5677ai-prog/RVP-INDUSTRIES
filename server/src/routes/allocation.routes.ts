import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  getAllocationHealth,
} from '../controllers/allocation.controller.js';

const router = Router();

router.get('/allocation-health', asyncHandler(getAllocationHealth));

export default router;
