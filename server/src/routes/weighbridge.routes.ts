import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  getNextTicketNumberHandler,
  getTicketsHandler,
  getPendingSecondWeightHandler,
  createTicketHandler,
  completeSecondWeightHandler,
  cancelTicketHandler,
  streamCctvHandler,
  snapshotCctvHandler,
} from '../controllers/weighbridge.controller.js';

const router = Router();

router.get('/cctv/stream', asyncHandler(streamCctvHandler));
router.get('/cctv/snapshot', asyncHandler(snapshotCctvHandler));
router.get('/next-number', asyncHandler(getNextTicketNumberHandler));
router.get('/tickets', asyncHandler(getTicketsHandler));
router.get('/pending', asyncHandler(getPendingSecondWeightHandler));
router.post('/tickets', asyncHandler(createTicketHandler));
router.post('/tickets/:id/second-weight', asyncHandler(completeSecondWeightHandler));
router.patch('/tickets/:id/cancel', asyncHandler(cancelTicketHandler));

export default router;
