import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  listWhatsAppLogs,
  sendPartyReminder,
  listTransportConfirmations,
  confirmTransportConfirmation,
  dismissTransportConfirmation,
  sendDispatchWhatsApp,
  resendDriverWhatsApp,
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
// Re-send just the driver's message (normally fires once, at dispatch creation).
router.post('/whatsapp/dispatches/:id/resend-driver', asyncHandler(resendDriverWhatsApp));

export default router;
