import type { Request, Response, NextFunction } from 'express';
import { recordAudit } from '../services/audit.service.js';
import { logger } from '../lib/logger.js';
import { scrubText } from '../lib/logScrubber.js';

/**
 * Record when a lot of rows leave the API at once (Phase 5, plan item 4).
 *
 * ---------------------------------------------------------------------------
 * Why this, and not a `report.export` gate
 *
 * The plan asks for exports to be gated by `report.export`, audited, and
 * watermarked. There are **no server-side exports**: `exceljs` and `jspdf` are
 * *client* dependencies, so every spreadsheet and PDF export is assembled in
 * the browser out of data it has already fetched. A permission check cannot
 * gate what the browser does with bytes it already holds, and a watermark
 * written there can be removed by whoever generated it.
 *
 * What the server *can* see is the fetch that feeds the export - the
 * `?all=true` reads that the dues and ledger pages use to pull a whole
 * register. So that is what is recorded: not a pretence of prevention, but an
 * honest record of how much data left, to whom, and when.
 *
 * **Deliberately not a permission gate.** Requiring `report.export` for
 * `?all=true` was the obvious next step and would have been a bug: the dues
 * and ledger pages *must* fetch `?all=true` or they compute phantom dues from
 * a truncated page, and a USER holds `report.view` but not `report.export`.
 * Gating it would have broken the dues screens for every ordinary user in the
 * name of security. Recording beats breaking.
 * ---------------------------------------------------------------------------
 *
 * Implemented by wrapping `res.json` once, centrally, rather than asking each
 * controller to report its own row count. A call site that has to be
 * remembered is one a future endpoint forgets - the same reasoning as the
 * audit extension in Phase 4.
 */

/** Rows at or above which a read is worth a row in the trail. */
const AUDIT_ROWS = Number(process.env.BULK_READ_AUDIT_ROWS ?? 500);

/** Rows at or above which it is worth shouting about in the logs. */
const ALERT_ROWS = Number(process.env.BULK_READ_ALERT_ROWS ?? 5000);

/**
 * How many rows a response body carries, or null if it is not a collection.
 *
 * Handles the shapes this API actually returns: a bare array, and the
 * `{ rows, nextCursor }` envelope the paged endpoints use.
 */
export function countRows(body: unknown): number | null {
  if (Array.isArray(body)) return body.length;
  if (body && typeof body === 'object') {
    for (const key of ['rows', 'items', 'data', 'results'] as const) {
      const v = (body as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v.length;
    }
  }
  return null;
}

/** True when this read is big enough to record. Exported for the tests. */
export function isAuditable(rows: number | null): boolean {
  return rows !== null && rows >= AUDIT_ROWS;
}

export function bulkReadThresholds(): { audit: number; alert: number } {
  return { audit: AUDIT_ROWS, alert: ALERT_ROWS };
}

export function bulkReadAudit() {
  return (req: Request, res: Response, next: NextFunction) => {
    // Only reads. A write is already audited row by row by the Prisma
    // extension, which is a better record than a count.
    if (req.method !== 'GET') return next();

    const sendJson = res.json.bind(res);
    res.json = (body: unknown) => {
      try {
        const rows = countRows(body);
        if (isAuditable(rows)) {
          // The query string is the signal worth keeping - `?all=true` is what
          // distinguishes a register dump from a page - but it is scrubbed on
          // the way in, because a filter could carry anything.
          const query = scrubText(
            new URLSearchParams(req.query as Record<string, string>).toString()
          );

          if (rows !== null && rows >= ALERT_ROWS) {
            logger.warn(
              `[bulk-read] ${rows} rows from ${req.path} by ${req.user?.userId ?? 'anonymous'}`
            );
          }

          // Fire and forget: recordAudit never throws, and a response must not
          // wait on the trail to be written.
          void recordAudit({
            action: 'data.bulk_read',
            entity: null,
            entityLabel: `${rows} rows from ${req.path}`,
            newValues: { path: req.path, rows, query: query || null },
          });
        }
      } catch (err) {
        // Never let the record-keeping break the response it is observing.
        logger.warn('[bulk-read] could not record a bulk read', err);
      }
      return sendJson(body);
    };

    next();
  };
}
