import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  listDeliveryChallans,
  getDeliveryChallan,
  createDeliveryChallan,
  updateDeliveryChallan,
  cancelDeliveryChallan,
  generateChallanEwbHandler,
  cancelChallanEwbHandler,
  extendChallanEwbValidityHandler,
} from '../controllers/deliveryChallan.controller.js';

const router = Router();

router.get('/', asyncHandler(listDeliveryChallans));
router.get('/:id', asyncHandler(getDeliveryChallan));
router.post('/', asyncHandler(createDeliveryChallan));
router.put('/:id', asyncHandler(updateDeliveryChallan));
router.post('/:id/cancel', asyncHandler(cancelDeliveryChallan));
router.post('/:id/ewb', asyncHandler(generateChallanEwbHandler));
router.post('/:id/ewb/cancel', asyncHandler(cancelChallanEwbHandler));
router.post('/:id/ewb/extend-validity', asyncHandler(extendChallanEwbValidityHandler));

export default router;
