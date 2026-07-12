import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireRole } from '../middleware/auth.js';
import {
  listFreightRates,
  upsertFreightRates,
  deleteFreightRate,
  getCompanyProfile,
  updateCompanyProfile,
  updateInvoiceLayout,
  getProductTax,
  updateProductTax,
  listProductionCostComponents,
  updateProductionCostComponents,
  getHamaliRates,
  updateHamaliRates,
} from '../controllers/settings.controller.js';

const router = Router();

// Reads stay open to any authenticated user (many pages need rates for live
// costing). Writes change company-wide config, so they need a privileged role.
const canEditSettings = requireRole('ADMIN', 'OWNER', 'DEVELOPER');

router.get('/settings/freight-rates', asyncHandler(listFreightRates));
router.put('/settings/freight-rates', canEditSettings, asyncHandler(upsertFreightRates));
router.delete('/settings/freight-rates/:id', canEditSettings, asyncHandler(deleteFreightRate));

router.get('/settings/company', asyncHandler(getCompanyProfile));
router.put('/settings/company', canEditSettings, asyncHandler(updateCompanyProfile));
router.put('/settings/invoice-layout', canEditSettings, asyncHandler(updateInvoiceLayout));

router.get('/settings/product-tax', asyncHandler(getProductTax));
router.put('/settings/product-tax', canEditSettings, asyncHandler(updateProductTax));

router.get('/settings/production-cost', asyncHandler(listProductionCostComponents));
router.put('/settings/production-cost', canEditSettings, asyncHandler(updateProductionCostComponents));

router.get('/settings/hamali-rates', asyncHandler(getHamaliRates));
router.put('/settings/hamali-rates', canEditSettings, asyncHandler(updateHamaliRates));

export default router;
