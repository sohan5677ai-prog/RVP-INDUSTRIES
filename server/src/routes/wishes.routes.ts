import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireRole } from '../middleware/auth.js';
import {
  listDrivers,
  createDriver,
  updateDriver,
  deleteDriver,
  bulkTagPartyReligion,
  bulkTagBrokerReligion,
  bulkTagTransportReligion,
  updatePartyPhone,
  updateBrokerPhone,
  updateTransportPhone,
  previewRecipients,
  generateWishText,
  generateWishImageEndpoint,
  sendWishBroadcast,
  listWishHistory,
} from '../controllers/wishes.controller.js';

const router = Router();

// Sending, editing the driver directory and bulk-tagging parties are
// privileged - same bar as Settings edits and the owner-digest "Send Now".
const canManage = requireRole('ADMIN', 'OWNER', 'DEVELOPER');

router.get('/wishes/drivers', asyncHandler(listDrivers));
router.post('/wishes/drivers', canManage, asyncHandler(createDriver));
router.put('/wishes/drivers/:id', canManage, asyncHandler(updateDriver));
router.delete('/wishes/drivers/:id', canManage, asyncHandler(deleteDriver));

router.post('/wishes/parties/bulk-religion', canManage, asyncHandler(bulkTagPartyReligion));
router.patch('/wishes/parties/:id/phone', canManage, asyncHandler(updatePartyPhone));
router.post('/wishes/brokers/bulk-religion', canManage, asyncHandler(bulkTagBrokerReligion));
router.patch('/wishes/brokers/:id/phone', canManage, asyncHandler(updateBrokerPhone));
router.post('/wishes/transports/bulk-religion', canManage, asyncHandler(bulkTagTransportReligion));
router.patch('/wishes/transports/:id/phone', canManage, asyncHandler(updateTransportPhone));

router.get('/wishes/recipients', asyncHandler(previewRecipients));
router.post('/wishes/generate/text', asyncHandler(generateWishText));
router.post('/wishes/generate/image', asyncHandler(generateWishImageEndpoint));

router.post('/wishes/send', canManage, asyncHandler(sendWishBroadcast));
router.get('/wishes/history', asyncHandler(listWishHistory));

export default router;
