import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { listNotes, getNote, createNote, getNotePdf, emailNote, listPendingCreditNotes } from '../controllers/notes.controller.js';

const router = Router();

router.get('/credit-notes', asyncHandler(listNotes('CREDIT')));
router.get('/credit-notes/pending', asyncHandler(listPendingCreditNotes));
router.get('/credit-notes/:id', asyncHandler(getNote('CREDIT')));
router.post('/credit-notes', asyncHandler(createNote('CREDIT')));
router.get('/credit-notes/:id/pdf', asyncHandler(getNotePdf('CREDIT')));
router.post('/credit-notes/:id/email', asyncHandler(emailNote('CREDIT')));

router.get('/debit-notes', asyncHandler(listNotes('DEBIT')));
router.get('/debit-notes/:id', asyncHandler(getNote('DEBIT')));
router.post('/debit-notes', asyncHandler(createNote('DEBIT')));
router.get('/debit-notes/:id/pdf', asyncHandler(getNotePdf('DEBIT')));
router.post('/debit-notes/:id/email', asyncHandler(emailNote('DEBIT')));

export default router;
