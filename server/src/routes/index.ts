import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import { subscriptionGate } from '../middleware/subscription.js';
import { webhookLimiter, bulkImportLimiter } from '../middleware/rateLimit.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { clearCache } from '../lib/cache.js';
import authRoutes from './auth.routes.js';
import { parseBulkImport } from '../controllers/bulkImport.controller.js';
import partyRoutes from './party.routes.js';
import brokerRoutes from './broker.routes.js';
import purchaseRoutes from './purchase.routes.js';
import saleRoutes from './sale.routes.js';
import dashboardRoutes from './dashboard.routes.js';
import systemRoutes from './system.routes.js';
import ledgerRoutes from './ledger.routes.js';
import inventoryRoutes from './inventory.routes.js';
import settingsRoutes from './settings.routes.js';
import paymentRoutes from './payment.routes.js';
import receiptRoutes from './receipt.routes.js';
import loanRoutes from './loan.routes.js';
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
import { verifyWhatsAppWebhook, handleWhatsAppWebhook, runWhatsAppJob } from '../controllers/whatsapp.controller.js';
import { globalSearch } from '../controllers/search.controller.js';
import subscriptionRoutes from './subscription.routes.js';
const router = Router();

// Public
router.use('/auth', authRoutes);
// Fast2SMS calls this from outside — no JWT. GET answers URL-validation probes.
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

// Licensing gate: once past auth, a locked deployment 402s every protected call
// (the DEVELOPER role bypasses). Runs before the cache/route handlers so no
// business route executes while unpaid.
router.use(subscriptionGate);

// The heavy read aggregates (unified stock engine, pappu-order margins) are memoized
// in-process. Any successful mutation can invalidate those figures, so bust the whole
// compute cache after every non-GET that returns a 2xx. Centralizing it here means a
// new write route can never forget to invalidate — and lets the TTL be longer (fast
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

// Buffered fully into memory before parsing, so cap both the size (was 20MB —
// spreadsheets this route parses are never anywhere near that) and how often
// one client can trigger it, to bound worst-case concurrent memory pressure.
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
router.post('/bulk-import/parse', bulkImportLimiter, memUpload.single('file'), asyncHandler(parseBulkImport));

router.use('/parties', partyRoutes);
router.use('/brokers', brokerRoutes);
router.use('/', purchaseRoutes);
router.use('/', saleRoutes);
router.use('/', dashboardRoutes);
router.use('/', ledgerRoutes);
router.use('/', inventoryRoutes);
router.use('/', settingsRoutes);
router.use('/', paymentRoutes);
router.use('/', receiptRoutes);
router.use('/', loanRoutes);
router.use('/', manualHamaliCostRoutes);
router.use('/', hamaliVerificationRoutes);
router.use('/', poolReportRoutes);
router.use('/', reportRoutes);
router.use('/', notesRoutes);
router.use('/', emailLogRoutes);
router.use('/', whatsappRoutes);
router.use('/system', systemRoutes);
router.use('/chat', chatRoutes);
router.use('/users', userRoutes);
router.use('/', taxproRoutes);

router.get('/search', asyncHandler(globalSearch));

export default router;
