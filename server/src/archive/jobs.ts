/**
 * In-process registry of running archive jobs.
 *
 * An export of a full year takes tens of seconds; Render kills long-running
 * requests, so the POST returns a job id immediately and the Archive Manager
 * page polls. State is in memory on purpose for now - persisting it needs an
 * `ArchiveJob` table, which lands with the Phase 0 schema change. The cost of
 * that choice: a dyno restart mid-export loses the job (the export is read-only,
 * so nothing is damaged - it just has to be re-run).
 */
import crypto from 'node:crypto';
import type { Manifest } from './manifest.js';

export type JobStatus = 'RUNNING' | 'READY' | 'FAILED';

export interface ArchiveJob {
  id: string;
  kind: 'EXPORT';
  fyStart: number;
  status: JobStatus;
  /** 0-100. */
  progress: number;
  /** Model currently being written, for the progress line. */
  step: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  error: string | null;
  createdBy: string;
  // Set once READY.
  fileName?: string;
  /** Local temp path, when the archive is still on this dyno's disk. */
  filePath?: string;
  bytes?: number;
  /** Supabase Storage object name, when the upload succeeded. */
  objectName?: string;
  manifest?: Manifest;
}

const JOBS = new Map<string, ArchiveJob>();

/** Finished jobs are dropped after this long, so temp files don't accumulate. */
const RETENTION_MS = 60 * 60 * 1000;

export function createJob(fyStart: number, createdBy: string): ArchiveJob {
  const job: ArchiveJob = {
    id: crypto.randomUUID(),
    kind: 'EXPORT',
    fyStart,
    status: 'RUNNING',
    progress: 0,
    step: null,
    startedAt: new Date(),
    finishedAt: null,
    error: null,
    createdBy,
  };
  JOBS.set(job.id, job);
  return job;
}

export function getJob(id: string): ArchiveJob | undefined {
  return JOBS.get(id);
}

export function updateJob(id: string, patch: Partial<ArchiveJob>): void {
  const job = JOBS.get(id);
  if (job) Object.assign(job, patch);
}

export function listJobs(): ArchiveJob[] {
  return [...JOBS.values()].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
}

/** True while an export for this year is already in flight. */
export function hasRunningExport(fyStart: number): boolean {
  return [...JOBS.values()].some((j) => j.fyStart === fyStart && j.status === 'RUNNING');
}

export function reapExpiredJobs(onExpire: (job: ArchiveJob) => void): void {
  const cutoff = Date.now() - RETENTION_MS;
  for (const [id, job] of JOBS) {
    if (job.finishedAt && job.finishedAt.getTime() < cutoff) {
      JOBS.delete(id);
      onExpire(job);
    }
  }
}

/** Shape sent to the client - never leaks local filesystem paths. */
export function publicJob(job: ArchiveJob) {
  return {
    id: job.id,
    kind: job.kind,
    fyStart: job.fyStart,
    status: job.status,
    progress: job.progress,
    step: job.step,
    startedAt: job.startedAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
    error: job.error,
    fileName: job.fileName ?? null,
    bytes: job.bytes ?? null,
    manifest: job.manifest ?? null,
  };
}
