import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  listAccounts,
  listJournalEntries,
  listSilos,
} from '../controllers/ledger.controller.js';

const router = Router();

router.get('/ledger/accounts', asyncHandler(listAccounts));
router.get('/ledger/entries', asyncHandler(listJournalEntries));
router.get('/inventory/silos', asyncHandler(listSilos));

export default router;
