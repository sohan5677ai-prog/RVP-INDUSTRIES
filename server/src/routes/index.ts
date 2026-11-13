import express, { Router } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import { requireAuthOrCameraBridge } from '../middleware/cameraAuth.js';
import { requireMediaRead } from '../middleware/mediaAuth.js';
import { enforceRoutePermissions } from '../middleware/routePermission.js';
import { isOriginAllowed, originPolicyFromEnv } from '../lib/corsOrigin.js';
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
import dispatchSlotRoutes from './dispatchSlot.routes.js';
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
import roleRoutes from './role.routes.js';
import { verifyWhatsAppWebhook, handleWhatsAppWebhook, runWhatsAppJob } from '../controllers/whatsapp.controller.js';
import { handleResendWebhook } from '../controllers/resendWebhook.controller.js';
import { verifyGpsWebhook, handleGpsPush } from '../controllers/gps.controller.js';
import { globalSearch } from '../controllers/search.controller.js';
import subscriptionRoutes from './subscription.routes.js';
import archiveRoutes from './archive.routes.js';
import weighbridgeRoutes from './weighbridge.routes.js';
import deliveryChallanRoutes from './deliveryChallan.routes.js';
import gstr2bRoutes from './gstr2b.routes.js';
import gpsRoutes from './gps.routes.js';
import {
  streamCctvHandler,
  snapshotCctvHandler,
  detectPlateCctvHandler,
  broadcastCctvHandler,
  getCctvStatusHandler,
  queuePrintJobHandler,
  getPendingPrintJobsHandler,
  completePrintJobHandler,
  getPrintAgentStatusHandler,
  isTrustedCameraBridge,
  downloadSignedWeighbridgeSlipHandler,
  downloadSignedWeighbridgeSlipImageHandler,
} from '../controllers/weighbridge.controller.js';
const router = Router();

// Public
router.use('/auth', authRoutes);
// Public maintenance status endpoint for polling, unauthenticated screens & pre-login checks
router.get('/system/maintenance/status', asyncHandler(getMaintenanceStatusHandler));

// Static assets (logos, stamps, signatures). Company branding rather than
// business data, so the files stay public - but the wildcard ACAO is narrowed
// to the configured client origins, so only our own pages can read them
// cross-origin.
const assetOriginPolicy = originPolicyFromEnv();
router.use('/assets', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(origin, assetOriginPolicy)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, express.static(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets')));

// Weighbridge CCTV direct streaming & snapshots for <img> tags.
// index.ts registers these same paths at app level (ahead of the rate limiter)
// and so wins, but they are gated identically here: a future change that drops
// the app-level copies must not silently reopen them to the internet.
router.get('/weighbridge/cctv/stream', requireMediaRead, asyncHandler(streamCctvHandler));
router.get('/weighbridge/cctv/snapshot', requireMediaRead, asyncHandler(snapshotCctvHandler));
router.post('/weighbridge/cctv/detect-plate', requireAuthOrCameraBridge, asyncHandler(detectPlateCctvHandler));
router.post('/weighbridge/cctv/broadcast', asyncHandler(broadcastCctvHandler));
router.get('/weighbridge/cctv/status', requireMediaRead, asyncHandler(getCctvStatusHandler));
router.get('/weighbridge/tickets/:id/slip.pdf', asyncHandler(downloadSignedWeighbridgeSlipHandler));
router.get('/weighbridge/tickets/:id/slip.jpg', asyncHandler(downloadSignedWeighbridgeSlipImageHandler));

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
// The cabin print agent polls /pending and /complete, never /status - the only
// caller is the client's own screen, which sends a Bearer token.
router.get('/weighbridge/print-queue/status', printQueueAuth, asyncHandler(getPrintAgentStatusHandler));

// GPS positions pushed by a tracking provider (public - their server calls
// this, authenticated by GPS_PUSH_TOKEN inside the handler). Locanix is polled
// rather than pushing (services/locanix.service.ts), but the endpoint stays
// mounted: a second vendor is then a token, not a deployment.
router.get('/webhooks/gps', webhookLimiter, asyncHandler(verifyGpsWebhook));
router.post('/webhooks/gps', webhookLimiter, asyncHandler(handleGpsPush));

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
  const isReadonlyCabinData = req.method === 'GET' && (req.path === '/parties' || req.path === '/company-profile' || req.path === '/settings/company');
  if (!isWeighbridge && !isReadonlyCabinData) {
    return next(new HttpError(403, 'This device is limited to Kata Cabin operations'));
  }
  next();
});

// Authorization. One table (lib/routePermissions.ts) applied to every route,
// rather than a guard bolted onto each of 415 of them - so the whole model is
// readable in one place and this phase needed no edit to any route file.
//
// Ships in audit mode: unless RBAC_ENFORCE=true, a failing check is recorded
// and the request proceeds. 201 write endpoints previously needed nothing but
// a session, so switching to deny-by-default blind would have stopped someone
// mid-shift.
router.use(enforceRoutePermissions);

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
router.use('/', dispatchSlotRoutes);
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
router.use('/users', userRoutes);
router.use('/', roleRoutes);
router.use('/', taxproRoutes);
router.use('/', archiveRoutes);
router.use('/weighbridge', weighbridgeRoutes);
router.use('/delivery-challans', deliveryChallanRoutes);
router.use('/gstr2b', gstr2bRoutes);
router.use('/', gpsRoutes);

router.get('/search', asyncHandler(globalSearch));

export default router;
