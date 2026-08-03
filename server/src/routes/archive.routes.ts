import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireRole } from '../middleware/auth.js';
import {
  listFinancialYears,
  describeArchive,
  startExport,
  getExportJob,
  listExportJobs,
  downloadExport,
} from '../controllers/archive.controller.js';

const router = Router();

// An archive is every party's GSTIN, bank account and full transaction history
// in one file. DEVELOPER only, no exceptions.
router.use('/archive', requireRole('DEVELOPER'));

router.get('/archive/financial-years', asyncHandler(listFinancialYears));
router.get('/archive/describe', asyncHandler(describeArchive));

router.get('/archive/exports', asyncHandler(listExportJobs));
router.post('/archive/exports', asyncHandler(startExport));
router.get('/archive/exports/:id', asyncHandler(getExportJob));
router.get('/archive/exports/:id/download', asyncHandler(downloadExport));

export default router;
