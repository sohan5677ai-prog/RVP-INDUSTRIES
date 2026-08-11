import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { upload } from '../lib/upload.js';
import { requireRole } from '../middleware/auth.js';
import {
  createSupportTicket,
  listSupportTickets,
  updateSupportTicket,
} from '../controllers/support.controller.js';

const router = Router();

// Anyone signed in can report a problem - that is the whole point of the button.
// Multer only engages on multipart bodies, so a capture-less report still works.
router.post('/support/tickets', upload.single('screenshot'), asyncHandler(createSupportTicket));

// Reading and closing other people's tickets is an admin job.
router.get('/support/tickets', requireRole('ADMIN', 'DEVELOPER'), asyncHandler(listSupportTickets));
router.patch('/support/tickets/:id', requireRole('ADMIN', 'DEVELOPER'), asyncHandler(updateSupportTicket));

export default router;
