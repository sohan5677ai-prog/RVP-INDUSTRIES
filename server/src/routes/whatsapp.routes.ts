import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  listWhatsAppLogs,
  sendPartyReminder,
  listTransportConfirmations,
  confirmTransportConfirmation,
  dismissTransportConfirmation,
  sendDispatchWhatsApp,
} from '../controllers/whatsapp.controller.js';

const router = Router();

router.get('/whatsapp/logs', asyncHandler(listWhatsAppLogs));

// Pending-loads reminder to a supplier (Party Ledger button). Throttled server-side.
router.post('/whatsapp/parties/:partyId/reminder', asyncHandler(sendPartyReminder));

// Inbound transport-confirmation drafts (Surya Road Transport page).
router.get('/whatsapp/transport-confirmations', asyncHandler(listTransportConfirmations));
router.post('/whatsapp/transport-confirmations/:id/confirm', asyncHandler(confirmTransportConfirmation));
router.post('/whatsapp/transport-confirmations/:id/dismiss', asyncHandler(dismissTransportConfirmation));

// Invoice + EWB + driver bundle to the broker/buyer, and buyer details to the driver.
router.post('/whatsapp/dispatches/:id/send', asyncHandler(sendDispatchWhatsApp));

export default router;
