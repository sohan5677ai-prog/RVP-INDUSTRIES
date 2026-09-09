import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  listNotes,
  getNote,
  createNote,
  deleteNote,
  getNotePdf,
  emailNote,
  listPendingCreditNotes,
  generateNoteEinvoice,
  cancelNoteEinvoice,
} from '../controllers/notes.controller.js';

const router = Router();

router.get('/credit-notes', asyncHandler(listNotes('CREDIT')));
router.get('/credit-notes/pending', asyncHandler(listPendingCreditNotes));
router.get('/credit-notes/:id', asyncHandler(getNote('CREDIT')));
router.post('/credit-notes', asyncHandler(createNote('CREDIT')));
router.delete('/credit-notes/:id', asyncHandler(deleteNote('CREDIT')));
router.get('/credit-notes/:id/pdf', asyncHandler(getNotePdf('CREDIT')));
router.post('/credit-notes/:id/email', asyncHandler(emailNote('CREDIT')));
router.post('/credit-notes/:id/einvoice', asyncHandler(generateNoteEinvoice('CREDIT')));
router.post('/credit-notes/:id/einvoice/cancel', asyncHandler(cancelNoteEinvoice('CREDIT')));

router.get('/debit-notes', asyncHandler(listNotes('DEBIT')));
router.get('/debit-notes/:id', asyncHandler(getNote('DEBIT')));
router.post('/debit-notes', asyncHandler(createNote('DEBIT')));
router.delete('/debit-notes/:id', asyncHandler(deleteNote('DEBIT')));
router.get('/debit-notes/:id/pdf', asyncHandler(getNotePdf('DEBIT')));
router.post('/debit-notes/:id/email', asyncHandler(emailNote('DEBIT')));
router.post('/debit-notes/:id/einvoice', asyncHandler(generateNoteEinvoice('DEBIT')));
router.post('/debit-notes/:id/einvoice/cancel', asyncHandler(cancelNoteEinvoice('DEBIT')));

export default router;
