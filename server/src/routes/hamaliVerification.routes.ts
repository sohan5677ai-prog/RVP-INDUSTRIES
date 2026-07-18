import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  listHamaliVerifications,
  createHamaliVerification,
  deleteHamaliVerification,
  getHamaliTeamParty,
} from '../controllers/hamaliVerification.controller.js';

const router = Router();

router.get('/hamali-verifications', asyncHandler(listHamaliVerifications));
// Static path must precede the ':id' delete route to avoid being shadowed.
router.get('/hamali-verifications/team-party', asyncHandler(getHamaliTeamParty));
router.post('/hamali-verifications', asyncHandler(createHamaliVerification));
router.delete('/hamali-verifications/:id', asyncHandler(deleteHamaliVerification));

export default router;
