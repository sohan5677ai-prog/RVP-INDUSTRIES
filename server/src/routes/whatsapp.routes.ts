import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireRole } from '../middleware/auth.js';
import {
  listWhatsAppLogs,
  listOwnerWhatsAppJobs,
  runOwnerWhatsAppJobNow,
  updateOwnerWhatsAppJobSchedule,
  sendPartyReminder,
  getPartyReminderContext,
  sendPartyPaymentReminder,
  getPartyReminderSchedule,
  upsertPartyReminderSchedule,
  deletePartyReminderSchedule,
  sendPartyLedgerWhatsApp,
  sendBrokerLedgerWhatsApp,
  listTransportConfirmations,
  lookupLorryConfirmation,
  updateTransportConfirmation,
  dismissTransportConfirmation,
  restoreTransportConfirmation,
  sendDispatchWhatsApp,
  resendDriverWhatsApp,
  getDuesOnDate,
  sendDueOnDateSingle,
  sendDuesOnDateBulk,
  updatePartyDueTodaySchedule,
  sendLorryPaymentWhatsApp,
} from '../controllers/whatsapp.controller.js';

const router = Router();

router.get('/whatsapp/logs', asyncHandler(listWhatsAppLogs));

// Owner daily digests (Settings -> WhatsApp -> Owner Daily Messages): list the
// 5 toggleable jobs with their current on/off state + last-sent time, and let
// a privileged user fire one immediately regardless of the toggle.
const canRunOwnerJobs = requireRole('ADMIN', 'OWNER', 'DEVELOPER');
router.get('/whatsapp/owner-jobs', asyncHandler(listOwnerWhatsAppJobs));
router.post('/whatsapp/owner-jobs/:job/run', canRunOwnerJobs, asyncHandler(runOwnerWhatsAppJobNow));
router.put('/whatsapp/owner-jobs/:job/schedule', canRunOwnerJobs, asyncHandler(updateOwnerWhatsAppJobSchedule));

// Party & Broker "Dues on this Day" payment reminders (Settings -> Dues on this Day)
router.get('/whatsapp/dues-on-date', asyncHandler(getDuesOnDate));
router.post('/whatsapp/dues-on-date/send-single', asyncHandler(sendDueOnDateSingle));
router.post('/whatsapp/dues-on-date/send-bulk', asyncHandler(sendDuesOnDateBulk));
router.put('/whatsapp/dues-on-date/schedule', canRunOwnerJobs, asyncHandler(updatePartyDueTodaySchedule));

// Pending-loads reminder to a supplier (Party Ledger button). Throttled server-side.
router.post('/whatsapp/parties/:partyId/reminder', asyncHandler(sendPartyReminder));
// Which of the ledger's reminder buttons apply to this party (pending loads /
// outstanding invoices) - the page hides the ones that don't.
router.get('/whatsapp/parties/:partyId/reminder-context', asyncHandler(getPartyReminderContext));
// Payment reminder → the buyer, the broker(s) on the due invoices, or both.
router.post('/whatsapp/parties/:partyId/payment-reminder', asyncHandler(sendPartyPaymentReminder));
// Party Ledger "Schedule" option - fully custom recurring payment reminder for
// this one party (time/day/frequency + a stop condition). Fired by the sweep
// in whatsappJobs.ts, not by these routes - these just edit the row.
router.get('/whatsapp/parties/:partyId/reminder-schedule', asyncHandler(getPartyReminderSchedule));
router.put('/whatsapp/parties/:partyId/reminder-schedule', asyncHandler(upsertPartyReminderSchedule));
router.delete('/whatsapp/parties/:partyId/reminder-schedule', asyncHandler(deletePartyReminderSchedule));
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
// Lorry Payment summary → driver / transporter on WhatsApp.
router.post('/whatsapp/lorry-payment/send-summary', asyncHandler(sendLorryPaymentWhatsApp));

export default router;
