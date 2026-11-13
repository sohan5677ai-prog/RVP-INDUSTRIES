import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  listDispatchSlots,
  listDispatchBacklog,
  createDispatchSlot,
  updateDispatchSlot,
  deleteDispatchSlot,
  confirmDispatchSlot,
  unconfirmDispatchSlot,
  previewDispatchIndent,
  sendDispatchIndent,
} from '../controllers/dispatchSlot.controller.js';

const router = Router();

// Static paths first - `/backlog` and `/indent` must not be swallowed by `/:id`.
router.get('/dispatch-slots/backlog', asyncHandler(listDispatchBacklog));
router.get('/dispatch-slots/indent', asyncHandler(previewDispatchIndent));
router.post('/dispatch-slots/indent', asyncHandler(sendDispatchIndent));

router.get('/dispatch-slots', asyncHandler(listDispatchSlots));
router.post('/dispatch-slots', asyncHandler(createDispatchSlot));
router.put('/dispatch-slots/:id', asyncHandler(updateDispatchSlot));
router.delete('/dispatch-slots/:id', asyncHandler(deleteDispatchSlot));
router.post('/dispatch-slots/:id/confirm', asyncHandler(confirmDispatchSlot));
router.post('/dispatch-slots/:id/unconfirm', asyncHandler(unconfirmDispatchSlot));

export default router;
