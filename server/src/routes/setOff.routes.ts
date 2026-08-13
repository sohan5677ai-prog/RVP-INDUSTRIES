import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  getSetOffOpenItems,
  listSetOffs,
  createSetOff,
  deleteSetOff,
} from '../controllers/setOff.controller.js';

const router = Router();

// What is still open on both sides for one party, ready to be knocked off.
router.get('/set-offs/open/:partyId', asyncHandler(getSetOffOpenItems));
router.get('/set-offs', asyncHandler(listSetOffs));
router.post('/set-offs', asyncHandler(createSetOff));
// Reverses both legs and the contra entry together - a set-off is never half-undone.
router.delete('/set-offs/:id', asyncHandler(deleteSetOff));

export default router;
