import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  listParties,
  getParty,
  revealPartyBank,
  createParty,
  updateParty,
  deleteParty,
} from '../controllers/party.controller.js';

const router = Router();

router.get('/', asyncHandler(listParties));
// Before /:id so the specific path wins.
router.get('/:id/bank', asyncHandler(revealPartyBank));
router.get('/:id', asyncHandler(getParty));
router.post('/', asyncHandler(createParty));
router.put('/:id', asyncHandler(updateParty));
router.delete('/:id', asyncHandler(deleteParty));

export default router;
