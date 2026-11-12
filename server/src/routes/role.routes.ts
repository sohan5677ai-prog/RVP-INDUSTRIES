import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  getRoleMatrix,
  updateRolePermissions,
  resetRole,
  getPermissionDenials,
  listPendingChanges,
  approvePendingChange,
  rejectPendingChange,
} from '../controllers/role.controller.js';

const router = Router();

// Authorization for these comes from the route permission table
// (lib/routePermissions.ts): /roles* and /permission-denials* need
// role.manage, /pending-changes* needs the permission each request names,
// checked inside the maker-checker service against the recorded value.

router.get('/roles', asyncHandler(getRoleMatrix));
router.put('/roles/:role', asyncHandler(updateRolePermissions));
router.post('/roles/:role/reset', asyncHandler(resetRole));

router.get('/permission-denials', asyncHandler(getPermissionDenials));

router.get('/pending-changes', asyncHandler(listPendingChanges));
router.post('/pending-changes/:id/approve', asyncHandler(approvePendingChange));
router.post('/pending-changes/:id/reject', asyncHandler(rejectPendingChange));

export default router;
