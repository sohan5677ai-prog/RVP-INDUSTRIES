import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import { subscriptionGate } from '../middleware/subscription.js';
import { maintenanceGate } from '../middleware/maintenance.js';
import { webhookLimiter, bulkImportLimiter } from '../middleware/rateLimit.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { HttpError } from '../lib/httpError.js';
import { clearCache } from '../lib/cache.js';
import authRoutes from './auth.routes.js';
import { parseBulkImport } from '../controllers/bulkImport.controller.js';
import { getMaintenanceStatusHandler } from '../controllers/system.controller.js';
import partyRoutes from './party.routes.js';
import brokerRoutes from './broker.routes.js';
import transportRoutes from './transport.routes.js';
import purchaseRoutes from './purchase.routes.js';
import saleRoutes from './sale.routes.js';
import dashboardRoutes from './dashboard.routes.js';
import systemRoutes from './system.routes.js';
import ledgerRoutes from './ledger.routes.js';
import inventoryRoutes from './inventory.routes.js';
import settingsRoutes from './settings.routes.js';
import paymentRoutes from './payment.routes.js';
import receiptRoutes from './receipt.routes.js';
import setOffRoutes from './setOff.routes.js';
import loanRoutes from './loan.routes.js';
import privateLoanRoutes from './privateLoan.routes.js';
import chatRoutes from './chat.routes.js';
import userRoutes from './user.routes.js';
import taxproRoutes from './taxpro.routes.js';
import manualHamaliCostRoutes from './manualHamaliCost.routes.js';
import hamaliVerificationRoutes from './hamaliVerification.routes.js';
import poolReportRoutes from './poolReport.routes.js';
import reportRoutes from './report.routes.js';
import notesRoutes from './notes.routes.js';
import emailLogRoutes from './emailLog.routes.js';
import whatsappRoutes from './whatsapp.routes.js';
import wishesRoutes from './wishes.routes.js';
import supportRoutes from './support.routes.js';
import userNoteRoutes from './userNote.routes.js';
import { verifyWhatsAppWebhook, handleWhatsAppWebhook, runWhatsAppJob } from '../controllers/whatsapp.controller.js';
import { handleResendWebhook } from '../controllers/resendWebhook.controller.js';
import { globalSearch } from '../controllers/search.controller.js';
import subscriptionRoutes from './subscription.routes.js';
import archiveRoutes from './archive.routes.js';
import weighbridgeRoutes from './weighbridge.routes.js';
import deliveryChallanRoutes from './deliveryChallan.routes.js';
import gstr2bRoutes from './gstr2b.routes.js';
import {
  streamCctvHandler,
  snapshotCctvHandler,
  broadcastCctvHandler,
  getCctvStatusHandler,
  queuePrintJobHandler,
  getPendingPrintJobsHandler,
  completePrintJobHandler,
  getPrintAgentStatusHandler,
  isTrustedCameraBridge,
  downloadSignedWeighbridgeSlipHandler,
} from '../controllers/weighbridge.controller.js';
const router = Router();

// Public
router.use('/auth', authRoutes);
// Public maintenance status endpoint for polling, unauthenticated screens & pre-login checks
router.get('/system/maintenance/status', asyncHandler(getMaintenanceStatusHandler));

// Weighbridge CCTV direct streaming & snapshots for <img> tags
router.get('/weighbridge/cctv/stream', asyncHandler(streamCctvHandler));
router.get('/weighbridge/cctv/snapshot', asyncHandler(snapshotCctvHandler));
router.post('/weighbridge/cctv/broadcast', asyncHandler(broadcastCctvHandler));
router.get('/weighbridge/cctv/status', asyncHandler(getCctvStatusHandler));
router.get('/weighbridge/tickets/:id/slip.pdf', asyncHandler(downloadSignedWeighbridgeSlipHandler));

// Weighbridge Print Queue routes (authenticated via X-CCTV-Bridge-Key or Bearer JWT)
const printQueueAuth = (req: any, res: any, next: any) => {
  if (isTrustedCameraBridge(req)) {
    return next();
  }
  requireAuth(req, res, next);
};
router.post('/weighbridge/print-queue', printQueueAuth, asyncHandler(queuePrintJobHandler));
router.get('/weighbridge/print-queue/pending', printQueueAuth, asyncHandler(getPendingPrintJobsHandler));
router.patch('/weighbridge/print-queue/:id/complete', printQueueAuth, asyncHandler(completePrintJobHandler));
router.get('/weighbridge/print-queue/status', asyncHandler(getPrintAgentStatusHandler));

// Resend email delivery/tracking webhook (public - Resend calls this, Svix signed)
router.post('/webhooks/resend', webhookLimiter, asyncHandler(handleResendWebhook));

// Fast2SMS calls this from outside - no JWT. GET answers URL-validation probes.
// No secret in the URL, so it needs its own limiter (the global apiLimiter is
// per-route via router.use('/api', apiLimiter, ...) but generous 1000/15min
// buckets are shared across all public+authed traffic).
router.get('/webhooks/whatsapp', webhookLimiter, asyncHandler(verifyWhatsAppWebhook));
router.post('/webhooks/whatsapp', webhookLimiter, asyncHandler(handleWhatsAppWebhook));
// Scheduled WhatsApp jobs, runnable by an external cron. Public but guarded by
// CRON_SECRET inside the handler (like the webhook, no JWT).
router.post('/webhooks/whatsapp/jobs/:job', webhookLimiter, asyncHandler(runWhatsAppJob));

// Subscription/licensing endpoints. Mounted BEFORE the global requireAuth and
// the subscription gate: its Razorpay webhook is public (no JWT), and its
// status/pay routes must stay reachable while the deployment is locked so the
// paywall can function. It applies its own per-route auth internally.
router.use('/subscription', subscriptionRoutes);

// Everything below requires a valid token.
router.use(requireAuth);

// A kata-cabin token is intentionally useful only for its compact operating
// screen. It cannot be replayed to browse accounting, party, or user data.
router.use((req, _res, next) => {
  if (req.user?.scope !== 'KATA_CABIN') return next();
  const isWeighbridge = req.path === '/weighbridge' || req.path.startsWith('/weighbridge/');
  const isReadonlyCabinData = req.method === 'GET' && (req.path === '/parties' || req.path === '/company-profile');
  if (!isWeighbridge && !isReadonlyCabinData) {
    return next(new HttpError(403, 'This device is limited to Kata Cabin operations'));
  }
  next();
});

// Developer Maintenance Gate: when maintenance mode is active, non-developers
// receive HTTP 503 with the live countdown and developer message. The DEVELOPER role bypasses.
router.use(maintenanceGate);

// Licensing gate: once past auth, a locked deployment 402s every protected call
// (the DEVELOPER role bypasses). Runs before the cache/route handlers so no
// business route executes while unpaid.
router.use(subscriptionGate);

// The heavy read aggregates (unified stock engine, pappu-order margins) are memoized
// in-process. Any successful mutation can invalidate those figures, so bust the whole
// compute cache after every non-GET that returns a 2xx. Centralizing it here means a
// new write route can never forget to invalidate - and lets the TTL be longer (fast
// read-only navigation) without ever serving data a write just changed.
router.use((req, res, next) => {
  const method = req.method;
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    res.on('finish', () => {
      if (res.statusCode < 400) clearCache();
    });
  }
  next();
});

// Buffered fully into memory before parsing, so cap both the size (was 20MB -
// spreadsheets this route parses are never anywhere near that) and how often
// one client can trigger it, to bound worst-case concurrent memory pressure.
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
router.post('/bulk-import/parse', bulkImportLimiter, memUpload.single('file'), asyncHandler(parseBulkImport));

router.use('/parties', partyRoutes);
router.use('/brokers', brokerRoutes);
router.use('/transports', transportRoutes);
router.use('/', purchaseRoutes);
router.use('/', saleRoutes);
router.use('/', dashboardRoutes);
router.use('/', ledgerRoutes);
router.use('/', inventoryRoutes);
router.use('/', settingsRoutes);
router.use('/', paymentRoutes);
router.use('/', receiptRoutes);
router.use('/', setOffRoutes);
router.use('/', loanRoutes);
router.use('/', privateLoanRoutes);
router.use('/', manualHamaliCostRoutes);
router.use('/', hamaliVerificationRoutes);
router.use('/', poolReportRoutes);
router.use('/', reportRoutes);
router.use('/', notesRoutes);
router.use('/', emailLogRoutes);
router.use('/', whatsappRoutes);
router.use('/', wishesRoutes);
router.use('/', supportRoutes);
router.use('/', userNoteRoutes);
router.use('/system', systemRoutes);
router.use('/chat', chatRoutes);
router.use('/users', userRoutes);
router.use('/', taxproRoutes);
router.use('/', archiveRoutes);
router.use('/weighbridge', weighbridgeRoutes);
router.use('/delivery-challans', deliveryChallanRoutes);
router.use('/gstr2b', gstr2bRoutes);

router.get('/search', asyncHandler(globalSearch));

export default router;
