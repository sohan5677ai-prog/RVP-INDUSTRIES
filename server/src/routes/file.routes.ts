import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { serveStoredFile } from '../controllers/file.controller.js';

const router = Router();

/**
 * A stored file is fetched by an `<img>` on the client origin, so it must say
 * so.
 *
 * helmet() sets `Cross-Origin-Resource-Policy: same-origin` on everything this
 * API serves, and the client is on another origin (rvpindustries.co.in loading
 * rvp-server.onrender.com). Without this header the browser throws the bytes
 * away after fetching them: the request succeeds, the `<img>` stays blank, and
 * nothing in the network tab looks wrong. That is what emptied the two CCTV
 * photos on the kata slip while the live camera grid - which sets this header
 * in snapshotCctvHandler - kept working.
 *
 * `cross-origin` does not open anything: the signed token in the query string
 * is still the only way to get a file, and the ACAO header set by the global
 * cors() still names the allowed origins. This only tells the browser it is
 * allowed to paint what it was already given. Same reasoning, same header, as
 * the /assets mount and the CCTV endpoints in routes/index.ts.
 */
router.use((_req, res, next) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
});

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
