import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  listHamaliVerifications,
  createHamaliVerification,
  deleteHamaliVerification,
} from '../controllers/hamaliVerification.controller.js';

const router = Router();

router.get('/hamali-verifications', asyncHandler(listHamaliVerifications));
router.post('/hamali-verifications', asyncHandler(createHamaliVerification));
router.delete('/hamali-verifications/:id', asyncHandler(deleteHamaliVerification));

export default router;
