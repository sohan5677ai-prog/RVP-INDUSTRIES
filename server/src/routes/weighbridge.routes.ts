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
  broadcastCctvHandler,
  getCctvStatusHandler,
  getStoredSnapshotHandler,
} from '../controllers/weighbridge.controller.js';

const router = Router();

router.get('/cctv/stream', asyncHandler(streamCctvHandler));
router.get('/cctv/snapshot', asyncHandler(snapshotCctvHandler));
router.post('/cctv/broadcast', asyncHandler(broadcastCctvHandler));
router.get('/cctv/status', asyncHandler(getCctvStatusHandler));
router.get('/snapshots/:filename', asyncHandler(getStoredSnapshotHandler));

// Scale serial live streaming routes
router.get('/scale/live', (req, res, next) => {
  import('../controllers/weighbridge.controller.js').then((m) => m.getLiveScaleHandler(req, res)).catch(next);
});
router.get('/scale/stream', (req, res, next) => {
  import('../controllers/weighbridge.controller.js').then((m) => m.streamLiveScaleHandler(req, res)).catch(next);
});
router.get('/scale/ports', (req, res, next) => {
  import('../controllers/weighbridge.controller.js').then((m) => m.listScalePortsHandler(req, res)).catch(next);
});
router.post('/scale/config', (req, res, next) => {
  import('../controllers/weighbridge.controller.js').then((m) => m.configScalePortHandler(req, res)).catch(next);
});
router.post('/scale/broadcast', (req, res, next) => {
  import('../controllers/weighbridge.controller.js').then((m) => m.broadcastScaleReadingHandler(req, res)).catch(next);
});

router.get('/next-number', asyncHandler(getNextTicketNumberHandler));
router.get('/tickets/next-number', asyncHandler(getNextTicketNumberHandler));
router.get('/tickets', asyncHandler(getTicketsHandler));
router.get('/pending', asyncHandler(getPendingSecondWeightHandler));
router.get('/tickets/pending', asyncHandler(getPendingSecondWeightHandler));
router.post('/tickets', asyncHandler(createTicketHandler));
router.post('/tickets/:id/second-weight', asyncHandler(completeSecondWeightHandler));
router.patch('/tickets/:id/second-weight', asyncHandler(completeSecondWeightHandler));
router.patch('/tickets/:id/cancel', asyncHandler(cancelTicketHandler));

export default router;
