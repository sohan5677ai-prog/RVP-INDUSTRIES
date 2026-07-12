import { Router } from 'express';
import { listUsers, createUser, updateUser, deleteUser } from '../controllers/user.controller.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireRole } from '../middleware/auth.js';

const router = Router();

// User administration is restricted to privileged roles. Without this, any
// authenticated USER could create or delete accounts (incl. their own admins).
router.use(requireRole('ADMIN', 'OWNER', 'DEVELOPER'));

router.get('/', asyncHandler(listUsers));
router.post('/', asyncHandler(createUser));
router.put('/:id', asyncHandler(updateUser));
router.delete('/:id', asyncHandler(deleteUser));

export default router;
