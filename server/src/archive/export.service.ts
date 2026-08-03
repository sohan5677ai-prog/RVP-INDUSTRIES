/**
 * Financial-year export: streams every in-scope row into a sealed .rvparchive.
 *
 * Nothing here writes to the database, so an export can never damage the books -
 * which is why this phase ships before the fyStart migration rather than after.
 * Scoping currently runs off business-date ranges (see registry.ts); once Phase 0
 * adds the column, only `whereForFy` changes.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { istFinancialYearRange, fyLabelLong, istParts } from '../lib/istDate.js';
import {
  ARCHIVE_MODELS,
  entryPath,
  stripOmitted,
  whereForFy,
  type ArchiveModel,
} from './registry.js';
import { encodeRow, canonicalJson } from './serialize.js';
import { deriveKey, newSalt } from './crypto.js';
import { spoolEntry, writeZip, type ZipEntry } from './zip.js';
import {
  ARCHIVE_FORMAT,
  FORMAT_VERSION,
  SCHEMA_VERSION,
  encryptionBlock,
  sealManifest,
  type Manifest,
  type ManifestEntry,
} from './manifest.js';

const PAGE_SIZE = 1_000;

export interface ExportOptions {
  fyStart: number;
  exportedBy: { userId: string; username: string };
  /** When set, every table and master file is AES-256-GCM encrypted. */
  passphrase?: string;
  /** Called after each model, for the progress bar on the Archive Manager page. */
  onProgress?: (done: number, total: number, model: string) => void;
}

export interface ExportResult {
  fileName: string;
  filePath: string;
  bytes: number;
  manifest: Manifest;
}

/** A Prisma delegate, narrowed to the two calls the exporter makes. */
interface Pageable {
  findMany(args: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
}

function delegateFor(m: ArchiveModel): Pageable {
  const client = prisma as unknown as Record<string, Pageable | undefined>;
  const delegate = client[m.delegate];
  if (!delegate?.findMany) {
    throw new Error(`No Prisma delegate "${m.delegate}" for archive model ${m.name}`);
  }
  return delegate;
}

/**
 * Keyset pagination by id. `skip`/`take` would re-scan from the top on every
 * page, turning a large table into an O(n²) export; a cursor stays O(n) and
 * holds at most PAGE_SIZE rows in memory.
 */
async function* pageRows(
  delegate: Pageable,
  where: Record<string, unknown> | null,
): AsyncGenerator<Record<string, unknown>> {
  let cursor: string | undefined;
  for (;;) {
    const rows = await delegate.findMany({
      ...(where ? { where } : {}),
      take: PAGE_SIZE,
      orderBy: { id: 'asc' },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) return;
    for (const row of rows) yield row;
    if (rows.length < PAGE_SIZE) return;
    cursor = rows[rows.length - 1].id as string;
  }
}

async function* ndjsonOf(
  m: ArchiveModel,
  where: Record<string, unknown> | null,
  count: { rows: number },
): AsyncGenerator<string> {
  for await (const row of pageRows(delegateFor(m), where)) {
    count.rows += 1;
    yield `${encodeRow(stripOmitted(m, row))}\n`;
  }
}

/** Σ debit and Σ credit over the year's journal lines. Asserted equal. */
async function trialBalance(range: { from: Date; to: Date }) {
  const agg = await prisma.journalLine.aggregate({
    where: { journalEntry: { date: { gte: range.from, lt: range.to } } },
    _sum: { debit: true, credit: true },
  });
  const zero = new Prisma.Decimal(0);
  return {
    dr: (agg._sum.debit ?? zero).toFixed(),
    cr: (agg._sum.credit ?? zero).toFixed(),
  };
}

function archiveFileName(fyStart: number, at: Date): string {
  const p = istParts(at);
  const hour24 = p.ampm === 'PM' && p.hour !== '12'
    ? String(Number(p.hour) + 12).padStart(2, '0')
    : p.ampm === 'AM' && p.hour === '12' ? '00' : p.hour;
  return `FY${fyLabelLong(fyStart)}_RVP_${p.year}${p.month}${p.day}-${hour24}${p.minute}.rvparchive`;
}

export async function exportFinancialYear(opts: ExportOptions): Promise<ExportResult> {
  const { fyStart } = opts;
  const range = istFinancialYearRange(fyStart);
  const exportedAt = new Date();

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rvp-archive-'));
  try {
    const salt = opts.passphrase ? newSalt() : null;
    const key = opts.passphrase && salt ? await deriveKey(opts.passphrase, salt) : undefined;

    const entries: ManifestEntry[] = [];
    const zipEntries: ZipEntry[] = [];
    const manifestEntries: Record<string, ManifestEntry> = {};
    let totalRows = 0;

    for (const [index, model] of ARCHIVE_MODELS.entries()) {
      const where = whereForFy(model, fyStart, range);
      const count = { rows: 0 };
      const spooled = await spoolEntry({
        path: entryPath(model),
        tmpDir,
        chunks: ndjsonOf(model, where, count),
        key,
      });

      const entry: ManifestEntry = {
        model: model.name,
        rows: count.rows,
        plainBytes: spooled.plainBytes,
        sha256: spooled.sha256,
        ...(spooled.iv ? { iv: spooled.iv, tag: spooled.tag } : {}),
      };
      entries.push(entry);
      manifestEntries[entryPath(model)] = entry;
      zipEntries.push(spooled.entry);
      totalRows += count.rows;

      opts.onProgress?.(index + 1, ARCHIVE_MODELS.length, model.name);
    }

    const [profile, tb] = await Promise.all([
      prisma.companyProfile.findFirst({ select: { name: true, gstin: true } }),
      trialBalance(range),
    ]);

    if (tb.dr !== tb.cr) {
      // A year whose journal does not balance is a year whose books are wrong.
      // Better to refuse than to hand someone a sealed archive of bad data.
      throw new Error(
        `Trial balance does not balance for FY ${fyLabelLong(fyStart)}: Dr ${tb.dr} vs Cr ${tb.cr}`,
      );
    }

    const manifest = sealManifest({
      format: ARCHIVE_FORMAT,
      formatVersion: FORMAT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      erpCommit: process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? null,
      company: { name: profile?.name ?? 'RVP INDUSTRIES', gstin: profile?.gstin ?? null },
      financialYear: {
        fyStart,
        label: fyLabelLong(fyStart),
        from: range.from.toISOString(),
        to: range.to.toISOString(),
      },
      exportedAt: exportedAt.toISOString(),
      exportedAtIst: (() => {
        const p = istParts(exportedAt);
        return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}:${p.second} ${p.ampm}`;
      })(),
      exportedBy: opts.exportedBy,
      encryption: encryptionBlock(salt),
      entries: manifestEntries,
      totals: { trialBalanceDr: tb.dr, trialBalanceCr: tb.cr, rows: totalRows },
    });

    // Spooled last (it needs every checksum) but placed first in the zip, so a
    // reader can identify the archive without scanning to the central directory.
    const manifestSpool = await spoolEntry({
      path: 'manifest.json',
      tmpDir,
      chunks: (async function* () {
        yield canonicalJson(manifest);
      })(),
    });

    const fileName = archiveFileName(fyStart, exportedAt);
    const filePath = path.join(tmpDir, fileName);
    const bytes = await writeZip(filePath, [manifestSpool.entry, ...zipEntries], exportedAt);

    logger.info('archive.export.complete', {
      fyStart,
      fileName,
      bytes,
      rows: totalRows,
      encrypted: Boolean(key),
    });

    return { fileName, filePath, bytes, manifest };
  } catch (err) {
    await fsp.rm(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

/** Removes the temp directory a built archive lives in. */
export async function cleanupExport(filePath: string): Promise<void> {
  await fsp.rm(path.dirname(filePath), { recursive: true, force: true });
}

/** Random object name so a signed URL is the only way to reach an archive. */
export function storageObjectName(fileName: string): string {
  return `${crypto.randomBytes(8).toString('hex')}/${fileName}`;
}
