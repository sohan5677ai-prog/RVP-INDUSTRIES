import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  listTransports,
  getTransport,
  createTransport,
  updateTransport,
  deleteTransport,
} from '../controllers/transport.controller.js';

const router = Router();

router.get('/', asyncHandler(listTransports));
router.get('/:id', asyncHandler(getTransport));
router.post('/', asyncHandler(createTransport));
router.put('/:id', asyncHandler(updateTransport));
router.delete('/:id', asyncHandler(deleteTransport));

export default router;
