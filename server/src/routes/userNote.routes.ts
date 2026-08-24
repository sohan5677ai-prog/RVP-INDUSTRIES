import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  listUserNotes,
  getDueUserReminders,
  getUserNote,
  createUserNote,
  updateUserNote,
  toggleUserNoteStatus,
  deleteUserNote,
} from '../controllers/userNote.controller.js';

const router = Router();

router.get('/user-notes', asyncHandler(listUserNotes));
router.get('/user-notes/reminders/due', asyncHandler(getDueUserReminders));
router.get('/user-notes/:id', asyncHandler(getUserNote));
router.post('/user-notes', asyncHandler(createUserNote));
router.patch('/user-notes/:id', asyncHandler(updateUserNote));
router.patch('/user-notes/:id/toggle-status', asyncHandler(toggleUserNoteStatus));
router.delete('/user-notes/:id', asyncHandler(deleteUserNote));

export default router;
