import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  listAccounts,
  listJournalEntries,
  listSilos,
  listPartyLedgers,
  getPartyLedger,
  getBalanceSheet,
  getProfitLoss,
} from '../controllers/ledger.controller.js';

const router = Router();

router.get('/ledger/accounts', asyncHandler(listAccounts));
router.get('/ledger/entries', asyncHandler(listJournalEntries));
router.get('/reports/balance-sheet', asyncHandler(getBalanceSheet));
router.get('/reports/profit-loss', asyncHandler(getProfitLoss));
router.get('/ledger/parties', asyncHandler(listPartyLedgers));
router.get('/ledger/parties/:id', asyncHandler(getPartyLedger));
router.get('/inventory/silos', asyncHandler(listSilos));

export default router;
