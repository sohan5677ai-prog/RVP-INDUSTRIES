import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  listPrivateLoans,
  createPrivateLoan,
  updatePrivateLoan,
  deletePrivateLoan,
  createPrivateLoanRepayment,
  deletePrivateLoanRepayment,
  sendPrivateLoanStatement,
} from '../controllers/privateLoan.controller.js';

const router = Router();

router.get('/private-loans', asyncHandler(listPrivateLoans));
router.post('/private-loans', asyncHandler(createPrivateLoan));
router.put('/private-loans/:id', asyncHandler(updatePrivateLoan));
router.delete('/private-loans/:id', asyncHandler(deletePrivateLoan));

router.post('/private-loans/:id/repayments', asyncHandler(createPrivateLoanRepayment));
router.delete('/private-loan-repayments/:id', asyncHandler(deletePrivateLoanRepayment));

router.post('/private-loans/:id/send-statement', asyncHandler(sendPrivateLoanStatement));

export default router;
