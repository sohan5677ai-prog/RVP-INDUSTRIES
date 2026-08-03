import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { HttpError } from '../lib/httpError.js';
import { getSupabase, archiveBucket } from '../lib/supabase.js';
import { istFinancialYearStart, fyLabelLong } from '../lib/istDate.js';
import {
  exportFinancialYear,
  cleanupExport,
  storageObjectName,
} from '../archive/export.service.js';
import {
  createJob,
  getJob,
  hasRunningExport,
  listJobs,
  publicJob,
  reapExpiredJobs,
  updateJob,
} from '../archive/jobs.js';
import { ARCHIVE_MODELS, EXCLUDED, entryPath } from '../archive/registry.js';

const startExportSchema = z.object({
  fyStart: z.number().int().min(2000).max(2100),
  /**
   * Encryption is opt-out, not opt-in: the payload carries every party's GSTIN,
   * bank account number and IFSC.
   */
  passphrase: z.string().min(12, 'Passphrase must be at least 12 characters').optional(),
  encrypt: z.boolean().default(true),
});

/** Signed URLs are short-lived - an archive link must not outlive the session. */
const SIGNED_URL_TTL_SECONDS = 300;

/** Above this, the archive is not buffered for upload and stays on local disk. */
const MAX_UPLOAD_BYTES = 128 * 1024 * 1024;

/**
 * Financial years that actually contain data, derived from the earliest and
 * latest business dates. Stands in for the FinancialYear table until Phase 0.
 */
export async function listFinancialYears(_req: Request, res: Response) {
  const [firstEntry, lastEntry, firstPo, lastPo] = await Promise.all([
    prisma.journalEntry.findFirst({ orderBy: { date: 'asc' }, select: { date: true } }),
    prisma.journalEntry.findFirst({ orderBy: { date: 'desc' }, select: { date: true } }),
    prisma.purchaseOrder.findFirst({ orderBy: { poDate: 'asc' }, select: { poDate: true } }),
    prisma.purchaseOrder.findFirst({ orderBy: { poDate: 'desc' }, select: { poDate: true } }),
  ]);

  const dates = [firstEntry?.date, lastEntry?.date, firstPo?.poDate, lastPo?.poDate].filter(
    (d): d is Date => Boolean(d),
  );
  if (dates.length === 0) {
    res.json({ years: [], currentFyStart: istFinancialYearStart(new Date()) });
    return;
  }

  const earliest = istFinancialYearStart(new Date(Math.min(...dates.map((d) => d.getTime()))));
  const latest = istFinancialYearStart(new Date(Math.max(...dates.map((d) => d.getTime()))));
  const currentFyStart = istFinancialYearStart(new Date());

  const years = [];
  for (let fy = latest; fy >= earliest; fy--) {
    years.push({
      fyStart: fy,
      label: fyLabelLong(fy),
      // No FinancialYear table yet, so every year is open and live. Phase 0
      // replaces these with the stored status.
      status: fy === currentFyStart ? 'OPEN' : 'OPEN',
      source: 'live',
    });
  }
  res.json({ years, currentFyStart });
}

/** What an archive of this year would contain, without building one. */
export async function describeArchive(_req: Request, res: Response) {
  res.json({
    models: ARCHIVE_MODELS.map((m) => ({
      name: m.name,
      class: m.cls,
      entry: entryPath(m),
      dateField: m.dateField ?? null,
      omitted: m.omit ?? [],
      note: m.note ?? null,
    })),
    excluded: EXCLUDED.map((m) => ({ name: m.name, note: m.note ?? null })),
  });
}

export async function startExport(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  const { fyStart, passphrase, encrypt } = startExportSchema.parse(req.body);

  if (encrypt && !passphrase) {
    throw new HttpError(
      400,
      'A passphrase is required. Archives hold party GSTINs and bank details; pass encrypt:false only if you are deliberately exporting in the clear.',
    );
  }
  if (hasRunningExport(fyStart)) {
    throw new HttpError(409, `An export of FY ${fyLabelLong(fyStart)} is already running`);
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
    select: { id: true, username: true },
  });
  if (!user) throw new HttpError(404, 'User not found');

  const job = createJob(fyStart, user.id);
  res.status(202).json(publicJob(job));

  // Deliberately not awaited: the response is already sent and the client polls.
  void runExport(job.id, fyStart, user, encrypt ? passphrase : undefined);
}

async function runExport(
  jobId: string,
  fyStart: number,
  user: { id: string; username: string },
  passphrase: string | undefined,
) {
  try {
    const result = await exportFinancialYear({
      fyStart,
      exportedBy: { userId: user.id, username: user.username },
      passphrase,
      onProgress: (done, total, model) => {
        updateJob(jobId, { progress: Math.round((done / total) * 95), step: model });
      },
    });

    updateJob(jobId, {
      progress: 97,
      step: 'Uploading',
      fileName: result.fileName,
      filePath: result.filePath,
      bytes: result.bytes,
      manifest: result.manifest,
    });

    // Render's disk is ephemeral and may be one of several instances, so the
    // durable copy lives in Supabase Storage. A failed upload is not fatal - the
    // file is still downloadable from this dyno until the job is reaped.
    let objectName: string | undefined;
    try {
      // supabase-js has no reliable Node-stream upload path, so the archive is
      // buffered. Guarded by a size cap rather than assumed small: a realistic FY
      // compresses to single-digit MB, and anything past the cap stays on disk.
      if (result.bytes > MAX_UPLOAD_BYTES) {
        throw new Error(`Archive is ${result.bytes} bytes, above the ${MAX_UPLOAD_BYTES} upload cap`);
      }
      objectName = storageObjectName(result.fileName);
      const { error } = await getSupabase()
        .storage.from(archiveBucket())
        .upload(objectName, await fsp.readFile(result.filePath), {
          contentType: 'application/octet-stream',
          upsert: false,
        });
      if (error) throw new Error(error.message);
    } catch (err) {
      objectName = undefined;
      logger.warn('archive.export.upload_failed', {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    updateJob(jobId, {
      status: 'READY',
      progress: 100,
      step: null,
      finishedAt: new Date(),
      objectName,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('archive.export.failed', { jobId, fyStart, error: message });
    updateJob(jobId, { status: 'FAILED', step: null, finishedAt: new Date(), error: message });
  }
}

export async function getExportJob(req: Request, res: Response) {
  reapExpiredJobs((job) => {
    if (job.filePath) void cleanupExport(job.filePath);
  });
  const job = getJob(req.params.id);
  if (!job) throw new HttpError(404, 'Job not found or expired');
  res.json(publicJob(job));
}

export async function listExportJobs(_req: Request, res: Response) {
  res.json({ jobs: listJobs().map(publicJob) });
}

/**
 * Hands back the finished archive: a short-lived signed URL when the upload
 * succeeded, otherwise a direct stream off this dyno's disk.
 */
export async function downloadExport(req: Request, res: Response) {
  const job = getJob(req.params.id);
  if (!job) throw new HttpError(404, 'Job not found or expired');
  if (job.status !== 'READY') throw new HttpError(409, `Export is ${job.status}`);

  if (job.objectName) {
    const { data, error } = await getSupabase()
      .storage.from(archiveBucket())
      .createSignedUrl(job.objectName, SIGNED_URL_TTL_SECONDS, {
        download: job.fileName,
      });
    if (!error && data?.signedUrl) {
      res.json({ url: data.signedUrl, fileName: job.fileName, expiresIn: SIGNED_URL_TTL_SECONDS });
      return;
    }
    logger.warn('archive.download.sign_failed', { jobId: job.id, error: error?.message });
  }

  if (!job.filePath || !fs.existsSync(job.filePath)) {
    throw new HttpError(410, 'Archive is no longer available on this server - re-run the export');
  }

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${job.fileName}"`);
  if (job.bytes) res.setHeader('Content-Length', String(job.bytes));
  fs.createReadStream(job.filePath).pipe(res);
}
