import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import authRoutes from './auth.routes.js';
import partyRoutes from './party.routes.js';
import brokerRoutes from './broker.routes.js';
import purchaseRoutes from './purchase.routes.js';
import processingRoutes from './processing.routes.js';
import saleRoutes from './sale.routes.js';
import dashboardRoutes from './dashboard.routes.js';
import systemRoutes from './system.routes.js';
import ledgerRoutes from './ledger.routes.js';
import inventoryRoutes from './inventory.routes.js';

const router = Router();

// Public
router.use('/auth', authRoutes);

// Everything below requires a valid token.
router.use(requireAuth);

router.use('/parties', partyRoutes);
router.use('/brokers', brokerRoutes);
router.use('/', purchaseRoutes);
router.use('/', processingRoutes);
router.use('/', saleRoutes);
router.use('/', dashboardRoutes);
router.use('/', ledgerRoutes);
router.use('/', inventoryRoutes);
router.use('/system', systemRoutes);

export default router;
