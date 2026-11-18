import type { Request, Response } from 'express';
import { getSupabase, storageBucket } from '../lib/supabase.js';
import { HttpError } from '../lib/httpError.js';
import { logger } from '../lib/logger.js';
import { verifyFileToken } from '../lib/fileAccessToken.js';

/**
 * Serve a stored file against an expiring token (Phase 5, PHASE-6B M2).
 *
 * **This route is deliberately unauthenticated, and the token is the
 * authorization.** It has to be: WhatsApp's media fetcher pulls the URL
 * server-to-server with no headers, and in the browser these are loaded by
 * `<img src>` and `<a href>`, neither of which can send one. The same reasoning
 * as the camera and scale endpoints in
 * [PHASE-6B](../../docs/security/PHASE-6B.md), and as the weighbridge slip link
 * that already works this way.
 *
 * What it buys over the public bucket URL it replaces: the link **expires**,
 * and because it runs through our own code the access can be logged, rate
 * limited and - once the bucket is private - actually withdrawn.
 *
 * It redirects to a short-lived Supabase signed URL rather than streaming the
 * bytes. Streaming would put every invoice download through Render, which bills
 * outbound traffic and is the reason the CCTV relay was moved off it; a
 * redirect costs one small response and lets storage serve the file. The signed
 * URL it redirects to is given a deliberately short life, because it leaves our
 * control the moment it is handed over.
 */

/** How long the Supabase signed URL we redirect to is good for. */
const STORAGE_SIGNED_URL_SECONDS = 60;

export async function serveStoredFile(req: Request, res: Response) {
  const objectName = String(req.params.name ?? '');
  const result = verifyFileToken({
    objectName,
    exp: typeof req.query.exp === 'string' ? req.query.exp : undefined,
    sig: typeof req.query.sig === 'string' ? req.query.sig : undefined,
  });

  if (result !== 'ok') {
    // A bad name is a 404 - there is no such file to talk about. Everything
    // else is a 403 that says which, because "the link in my email stopped
    // working" is a support question that deserves an answer, and knowing a
    // link expired tells an attacker nothing they did not already supply.
    if (result === 'bad-name') throw new HttpError(404, 'No such file');
    if (result === 'expired') {
      throw new HttpError(403, 'That link has expired. Open the record in the app for a new one.');
    }
    throw new HttpError(403, 'That link is not valid.');
  }

  const supabase = getSupabase();
  const { data, error } = await supabase.storage
    .from(storageBucket())
    .createSignedUrl(objectName, STORAGE_SIGNED_URL_SECONDS);

  if (error || !data?.signedUrl) {
    // Logged rather than returned: the storage error can name the bucket and
    // the object, and the caller gets told only that it is not there.
    logger.warn(`[files] could not sign ${objectName}`, error ?? undefined);
    throw new HttpError(404, 'No such file');
  }

  // No-store: the redirect carries a credential in its target, and a shared
  // cache holding it would hand the file to the next person through.
  res.setHeader('Cache-Control', 'no-store');
  res.redirect(302, data.signedUrl);
}
