import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { serveStoredFile } from '../controllers/file.controller.js';

const router = Router();

/**
 * Deliberately unauthenticated - the signed token in the query string is the
 * authorization. It has to be: the WhatsApp media fetcher pulls the URL
 * server-to-server with no headers, and `<img src>` and `<a href>` cannot send
 * one either. See controllers/file.controller.ts.
 *
 * Mounted BEFORE the global requireAuth in routes/index.ts, which is what
 * makes that true - a rule in the permission table would not have, since the
 * table is only consulted after authentication has already happened.
 */
router.get('/:name', asyncHandler(serveStoredFile));

export default router;
