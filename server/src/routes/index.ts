import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import authRoutes from './auth.routes.js';
import { parseBulkImport } from '../controllers/bulkImport.controller.js';
import partyRoutes from './party.routes.js';
import brokerRoutes from './broker.routes.js';
import purchaseRoutes from './purchase.routes.js';
import processingRoutes from './processing.routes.js';
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
import allocationRoutes from './allocation.routes.js';

const router = Router();

// Public
router.use('/auth', authRoutes);

// Everything below requires a valid token.
router.use(requireAuth);

const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
router.post('/bulk-import/parse', memUpload.single('file'), asyncHandler(parseBulkImport));

router.use('/parties', partyRoutes);
router.use('/brokers', brokerRoutes);
router.use('/', purchaseRoutes);
router.use('/', processingRoutes);
router.use('/', saleRoutes);
router.use('/', dashboardRoutes);
router.use('/', ledgerRoutes);
router.use('/', inventoryRoutes);
router.use('/', settingsRoutes);
router.use('/', paymentRoutes);
router.use('/', receiptRoutes);
router.use('/', loanRoutes);
router.use('/system', systemRoutes);
router.use('/chat', chatRoutes);
router.use('/users', userRoutes);
router.use('/', taxproRoutes);
router.use('/', allocationRoutes);

export default router;

