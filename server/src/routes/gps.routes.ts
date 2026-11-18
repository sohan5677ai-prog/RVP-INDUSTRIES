import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  listVehiclePositions,
  getVehicleTrail,
  getFleetBoard,
  getVehicleDetail,
  getGpsStatus,
  triggerGpsPoll,
  getArrivalsBoard,
  triggerArrivalSweep,
} from '../controllers/gps.controller.js';

/**
 * Reads over the pushed GPS positions, for the ERP's own screens.
 *
 * The ingestion endpoint is public and lives in routes/index.ts ahead of
 * requireAuth; these two are behind it. The browser always reads our database,
 * never the provider - that keeps the push token server-side.
 */
const router = Router();

// The Vehicle Tracking page. /fleet is the board, /detail is one lorry.
router.get('/gps/fleet', asyncHandler(getFleetBoard));
router.get('/gps/status', asyncHandler(getGpsStatus));
router.get('/gps/vehicles', asyncHandler(listVehiclePositions));
router.get('/gps/vehicles/:vehicleNumber', asyncHandler(getVehicleTrail));
router.get('/gps/vehicles/:vehicleNumber/detail', asyncHandler(getVehicleDetail));

// Arriving purchase lorries - the Upcoming Vehicles tab and the kata cabin's
// arrivals strip. Readable by the cabin's own narrowly-scoped token, which is
// the point: the screen that needs to know a lorry is two km out is the one
// that cannot log in.
router.get('/gps/arrivals', asyncHandler(getArrivalsBoard));
router.post('/gps/arrivals/sweep', asyncHandler(triggerArrivalSweep));

// Pull from the provider now, rather than waiting for the next tick. A write
// only in the sense that it stores what it fetches - no ERP data changes - so
// it sits with the reads under the same sale.view permission.
router.post('/gps/poll', asyncHandler(triggerGpsPoll));

export default router;
