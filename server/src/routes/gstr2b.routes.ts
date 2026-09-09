import { Router } from 'express';
import {
  syncGstr2b,
  uploadGstr2bJson,
  getReconciliation,
  getImportedPeriods,
  deleteImport,
} from '../controllers/gstr2b.controller.js';
import { asyncHandler } from '../lib/asyncHandler.js';

const router = Router();

router.post('/sync', asyncHandler(syncGstr2b));
router.post('/upload-json', asyncHandler(uploadGstr2bJson));
router.get('/reconciliation', asyncHandler(getReconciliation));
router.get('/periods', asyncHandler(getImportedPeriods));
router.delete('/import/:id', asyncHandler(deleteImport));

export default router;
