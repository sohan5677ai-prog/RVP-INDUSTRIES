import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  listHamaliVerifications,
  createHamaliVerification,
  deleteHamaliVerification,
  getHamaliTeamParty,
  listHamaliRoundedValues,
  setHamaliRoundedValue,
  deleteHamaliRoundedValue,
  bulkSetHamaliRoundedValues,
} from '../controllers/hamaliVerification.controller.js';

const router = Router();

router.get('/hamali-verifications', asyncHandler(listHamaliVerifications));
// Static paths must precede the ':id' route to avoid being shadowed.
router.get('/hamali-verifications/team-party', asyncHandler(getHamaliTeamParty));
router.get('/hamali-verifications/rounded-values', asyncHandler(listHamaliRoundedValues));
router.post('/hamali-verifications/rounded-values', asyncHandler(setHamaliRoundedValue));
router.post('/hamali-verifications/rounded-values/bulk', asyncHandler(bulkSetHamaliRoundedValues));
router.delete('/hamali-verifications/rounded-values/:id', asyncHandler(deleteHamaliRoundedValue));
router.post('/hamali-verifications', asyncHandler(createHamaliVerification));
router.delete('/hamali-verifications/:id', asyncHandler(deleteHamaliVerification));

export default router;
