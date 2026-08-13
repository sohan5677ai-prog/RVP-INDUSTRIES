import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { upload } from '../lib/upload.js';
import { requireRole } from '../middleware/auth.js';
import {
  acknowledgeSupportTicket,
  createSupportTicket,
  listSupportAnnouncements,
  listSupportTickets,
  updateSupportTicket,
} from '../controllers/support.controller.js';

const router = Router();

// Anyone signed in can report a problem - that is the whole point of the button.
// Multer only engages on multipart bodies, so a capture-less report still works.
router.post('/support/tickets', upload.single('screenshot'), asyncHandler(createSupportTicket));

// Open to everyone signed in, but the controller decides what each role gets:
// admins and the developer see every ticket in full, everyone else sees their
// own reports plus the answered ones they are expected to acknowledge.
router.get('/support/tickets', asyncHandler(listSupportTickets));

// Answered tickets this person still has to tick off - what the login popup runs on.
router.get('/support/announcements', asyncHandler(listSupportAnnouncements));

// "Yes, checked" - anyone can clear a reply off their own popup.
router.post('/support/tickets/:id/ack', asyncHandler(acknowledgeSupportTicket));

// Resolving is the developer's alone: the reply that goes out to the whole
// company has to come from whoever actually fixed the thing, so an admin (who
// cannot write that answer) does not get the button. Reopening is the same act
// in reverse - it wipes the reply and everyone's acknowledgement - so it is
// gated the same way.
router.patch('/support/tickets/:id', requireRole('DEVELOPER'), asyncHandler(updateSupportTicket));

export default router;
