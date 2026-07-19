import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';
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
import notesRoutes from './notes.routes.js';
import emailLogRoutes from './emailLog.routes.js';
import whatsappRoutes from './whatsapp.routes.js';
import { verifyWhatsAppWebhook, handleWhatsAppWebhook } from '../controllers/whatsapp.controller.js';
import { globalSearch } from '../controllers/search.controller.js';
const router = Router();

// Public
router.use('/auth', authRoutes);
// Fast2SMS calls this from outside — no JWT. GET answers URL-validation probes.
router.get('/webhooks/whatsapp', asyncHandler(verifyWhatsAppWebhook));
router.post('/webhooks/whatsapp', asyncHandler(handleWhatsAppWebhook));

// Everything below requires a valid token.
router.use(requireAuth);

const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
router.post('/bulk-import/parse', memUpload.single('file'), asyncHandler(parseBulkImport));

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
router.use('/', notesRoutes);
router.use('/', emailLogRoutes);
router.use('/', whatsappRoutes);
router.use('/system', systemRoutes);
router.use('/chat', chatRoutes);
router.use('/users', userRoutes);
router.use('/', taxproRoutes);

router.get('/search', asyncHandler(globalSearch));

export default router;
