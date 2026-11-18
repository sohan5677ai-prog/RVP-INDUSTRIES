import type { Request, Response, NextFunction } from 'express';
import {
  mintFileUrl,
  objectNameFromStored,
  DEFAULT_FILE_TTL_SECONDS,
} from '../lib/fileAccessToken.js';
import { logger } from '../lib/logger.js';

/**
 * Hand out expiring links instead of public bucket URLs (Phase 5, PHASE-6B M2,
 * step two of three).
 *
 * ---------------------------------------------------------------------------
 * Why at the response layer, and by value rather than by field name
 *
 * Twelve columns across eight models hold a stored file URL: `StockIn
 * .invoiceFileUrl`, `SaleOrder.kataFileUrl`, `Payment.screenshotUrl`,
 * `WeighbridgeTicket.slipImageUrl` and the rest. Rewriting each read path
 * would mean finding every controller, every `include`, and every nested
 * shape - and a call site that has to be remembered is one a future endpoint
 * forgets. The same reasoning as the Phase 4 audit extension and the Phase 5
 * bulk-read recorder, both of which wrap one thing centrally.
 *
 * So this walks the outgoing JSON and replaces any value that is recognisably
 * one of our stored files. Matching on **shape, not field name**, means a new
 * column is covered the day it is added rather than the day someone remembers
 * it. `objectNameFromStored` only accepts our own storage URLs and bare
 * 32-hex-plus-extension names, so an unrelated link is left alone.
 *
 * The happy consequence: **nothing stored has to change.** Existing rows keep
 * their public URL in the database, and callers simply stop being told it.
 * That makes this step reversible and keeps it off the write paths entirely.
 * ---------------------------------------------------------------------------
 *
 * What it does not cover: anything that does not go out through `res.json`.
 * WhatsApp media is read straight from the database inside the send services
 * and needs a longer-lived link anyway, so it is minted there explicitly.
 */

/** Depth beyond which we stop walking a response body. */
const MAX_DEPTH = 12;

/**
 * A cheap test before the real one. Walking every string through
 * `objectNameFromStored` would be wasteful on a 500-row register, so only
 * strings that could possibly be ours are examined properly.
 */
function worthChecking(value: string): boolean {
  if (value.length < 36 || value.length > 2048) return false;
  return (
    value.includes('/storage/v1/object/') ||
    value.includes('/files/') ||
    /^[0-9a-f]{32}\./.test(value)
  );
}

/** Replace recognised stored-file values with freshly minted links. */
export function rewriteFileUrls(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet()
): unknown {
  if (typeof value === 'string') {
    if (!worthChecking(value)) return value;
    if (!objectNameFromStored(value)) return value;
    return mintFileUrl(value, DEFAULT_FILE_TTL_SECONDS)?.url ?? value;
  }

  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return value;
  if (value instanceof Date) return value;
  if (seen.has(value as object)) return value;

  seen.add(value as object);
  try {
    if (Array.isArray(value)) {
      let changed = false;
      const out = value.map((v) => {
        const next = rewriteFileUrls(v, depth + 1, seen);
        if (next !== v) changed = true;
        return next;
      });
      // Returning the original when nothing changed keeps a large register
      // response from being rebuilt for no reason.
      return changed ? out : value;
    }

    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const next = rewriteFileUrls(v, depth + 1, seen);
      if (next !== v) changed = true;
      out[key] = next;
    }
    return changed ? out : value;
  } finally {
    seen.delete(value as object);
  }
}

export function fileUrlRewrite() {
  return (_req: Request, res: Response, next: NextFunction) => {
    const sendJson = res.json.bind(res);
    res.json = (body: unknown) => {
      try {
        return sendJson(rewriteFileUrls(body));
      } catch (err) {
        // A failure here must not cost the caller their response. Falling back
        // to the original body means they get the public URL, which is what
        // they got before this existed - degraded, not broken.
        logger.warn('[file-urls] could not rewrite a response', err);
        return sendJson(body);
      }
    };
    next();
  };
}
