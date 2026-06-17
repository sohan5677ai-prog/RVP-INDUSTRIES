import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { listBrokers, createBroker, updateBroker, deleteBroker } from '../controllers/broker.controller.js';

const router = Router();

router.get('/', asyncHandler(listBrokers));
router.post('/', asyncHandler(createBroker));
router.put('/:id', asyncHandler(updateBroker));
router.delete('/:id', asyncHandler(deleteBroker));

export default router;
