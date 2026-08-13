import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  getSetOffOpenItems,
  listSetOffs,
  createSetOff,
  updateSetOff,
  deleteSetOff,
} from '../controllers/setOff.controller.js';

const router = Router();

// What is still open on both sides for one party, ready to be knocked off.
router.get('/set-offs/open/:partyId', asyncHandler(getSetOffOpenItems));
router.get('/set-offs', asyncHandler(listSetOffs));
router.post('/set-offs', asyncHandler(createSetOff));
// A correction restates both sides at once - the old legs and contra entry come
// out, the new ones go in, and the row keeps its id.
router.patch('/set-offs/:id', asyncHandler(updateSetOff));
// Reverses both legs and the contra entry together - a set-off is never half-undone.
router.delete('/set-offs/:id', asyncHandler(deleteSetOff));

export default router;
