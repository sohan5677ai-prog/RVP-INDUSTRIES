import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  listLoans,
  createLoan,
  deleteLoan,
  createRepayment,
  deleteRepayment,
  getLoanSettings,
  updateLoanSettings,
} from '../controllers/loan.controller.js';

const router = Router();

router.get('/loans/settings', asyncHandler(getLoanSettings));
router.put('/loans/settings', asyncHandler(updateLoanSettings));

router.get('/loans', asyncHandler(listLoans));
router.post('/loans', asyncHandler(createLoan));
router.delete('/loans/:id', asyncHandler(deleteLoan));

router.post('/loans/:id/repayments', asyncHandler(createRepayment));
router.delete('/loan-repayments/:id', asyncHandler(deleteRepayment));

export default router;
