import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  listWhatsAppLogs,
  sendPartyReminder,
  getPartyReminderContext,
  sendPartyPaymentReminder,
  sendPartyLedgerWhatsApp,
  sendBrokerLedgerWhatsApp,
  listTransportConfirmations,
  lookupLorryConfirmation,
  updateTransportConfirmation,
  dismissTransportConfirmation,
  restoreTransportConfirmation,
  sendDispatchWhatsApp,
  resendDriverWhatsApp,
} from '../controllers/whatsapp.controller.js';

const router = Router();

router.get('/whatsapp/logs', asyncHandler(listWhatsAppLogs));

// Pending-loads reminder to a supplier (Party Ledger button). Throttled server-side.
router.post('/whatsapp/parties/:partyId/reminder', asyncHandler(sendPartyReminder));
// Which of the ledger's reminder buttons apply to this party (pending loads /
// outstanding invoices) - the page hides the ones that don't.
router.get('/whatsapp/parties/:partyId/reminder-context', asyncHandler(getPartyReminderContext));
// Payment reminder → the buyer, the broker(s) on the due invoices, or both.
router.post('/whatsapp/parties/:partyId/payment-reminder', asyncHandler(sendPartyPaymentReminder));
router.post('/whatsapp/parties/:partyId/send-ledger', asyncHandler(sendPartyLedgerWhatsApp));
// Brokerage statement → broker, fired by the "WhatsApp Ledger" button on the
// Brokerage Report detail page.
router.post('/whatsapp/brokers/:brokerId/send-ledger', asyncHandler(sendBrokerLedgerWhatsApp));

// Lorry booking register, fed by the transporter's inbound WhatsApp messages
// (Freight Dues → Lorry Confirmations).
router.get('/whatsapp/transport-confirmations', asyncHandler(listTransportConfirmations));
// Ahead of the :id routes - "lookup" would otherwise be read as an id.
router.get('/whatsapp/transport-confirmations/lookup', asyncHandler(lookupLorryConfirmation));
router.patch('/whatsapp/transport-confirmations/:id', asyncHandler(updateTransportConfirmation));
router.post('/whatsapp/transport-confirmations/:id/dismiss', asyncHandler(dismissTransportConfirmation));
router.post('/whatsapp/transport-confirmations/:id/restore', asyncHandler(restoreTransportConfirmation));

// Invoice + EWB + driver bundle to the broker/buyer, and buyer details to the driver.
router.post('/whatsapp/dispatches/:id/send', asyncHandler(sendDispatchWhatsApp));
// Re-send just the driver's message (normally fires once, at dispatch creation).
router.post('/whatsapp/dispatches/:id/resend-driver', asyncHandler(resendDriverWhatsApp));

export default router;
