import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
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
} from '../controllers/settings.controller.js';

const router = Router();

router.get('/settings/freight-rates', asyncHandler(listFreightRates));
router.put('/settings/freight-rates', asyncHandler(upsertFreightRates));
router.delete('/settings/freight-rates/:id', asyncHandler(deleteFreightRate));

router.get('/settings/company', asyncHandler(getCompanyProfile));
router.put('/settings/company', asyncHandler(updateCompanyProfile));
router.put('/settings/invoice-layout', asyncHandler(updateInvoiceLayout));

router.get('/settings/product-tax', asyncHandler(getProductTax));
router.put('/settings/product-tax', asyncHandler(updateProductTax));

router.get('/settings/production-cost', asyncHandler(listProductionCostComponents));
router.put('/settings/production-cost', asyncHandler(updateProductionCostComponents));

export default router;
