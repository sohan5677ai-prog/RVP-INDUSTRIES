/**
 * Reads a .rvparchive's manifest in the browser, without uploading anything.
 *
 * The manifest is deliberately the only plaintext entry in an encrypted archive
 * (see docs/fy-archive-spec.md §2.4), so a dropped file can identify itself -
 * which year, how many rows, exported when - before anyone is asked for a
 * passphrase.
 *
 * Only three small ranges are ever read: the end-of-central-directory record,
 * the central directory, and the manifest entry itself. Identifying a 200 MB
 * archive costs the same as identifying a 40 KB one.
 */

export interface ManifestEntry {
  model: string;
  rows: number;
  plainBytes: number;
  sha256: string;
  iv?: string;
  tag?: string;
}

export interface ArchiveManifest {
  format: string;
  formatVersion: number;
  schemaVersion: number;
  erpCommit: string | null;
  company: { name: string; gstin: string | null };
  financialYear: { fyStart: number; label: string; from: string; to: string };
  exportedAt: string;
  exportedAtIst: string;
  exportedBy: { userId: string; username: string };
  encryption: { enabled: false } | { enabled: true; cipher: string; kdf: string; N: number };
  entries: Record<string, ManifestEntry>;
  totals: { trialBalanceDr: string; trialBalanceCr: string; rows: number };
  seal?: string;
}

export class ArchiveReadError extends Error {}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const METHOD_DEFLATE = 8;

async function sliceBytes(file: Blob, start: number, end: number): Promise<DataView> {
  const buf = await file.slice(start, end).arrayBuffer();
  return new DataView(buf);
}

async function inflateRaw(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  // DecompressionStream is unavailable on very old Safari; the archive is still
  // valid, the browser just can't read it here.
  if (typeof DecompressionStream === 'undefined') {
    throw new ArchiveReadError('This browser cannot decompress archives - try Chrome or Edge.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).arrayBuffer();
}

/** Locates the end-of-central-directory record by scanning back for its signature. */
async function findEocd(file: Blob): Promise<{ entries: number; cdOffset: number; cdSize: number }> {
  // No zip comment is ever written, so the record is the last 22 bytes. Scan a
  // window anyway, so a file that picked one up elsewhere still reads.
  const window = Math.min(file.size, 66_000);
  const view = await sliceBytes(file, file.size - window, file.size);

  for (let i = view.byteLength - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      return {
        entries: view.getUint16(i + 10, true),
        cdSize: view.getUint32(i + 12, true),
        cdOffset: view.getUint32(i + 16, true),
      };
    }
  }
  throw new ArchiveReadError('Not a valid archive - no zip central directory found.');
}

/** Central-directory record for one entry. */
interface CentralEntry {
  path: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

async function readCentralDirectory(file: Blob): Promise<CentralEntry[]> {
  const { entries: count, cdOffset, cdSize } = await findEocd(file);
  const view = await sliceBytes(file, cdOffset, cdOffset + cdSize);
  const decoder = new TextDecoder();

  const out: CentralEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== CENTRAL_SIGNATURE) {
      throw new ArchiveReadError('Archive central directory is damaged.');
    }
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const path = decoder.decode(new Uint8Array(view.buffer, view.byteOffset + p + 46, nameLen));

    out.push({ path, method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function readEntry(file: Blob, entry: CentralEntry): Promise<ArrayBuffer> {
  // The local header repeats the name and extra lengths, which can differ from
  // the central directory's - the data starts after whatever the local one says.
  const header = await sliceBytes(file, entry.localOffset, entry.localOffset + 30);
  if (header.getUint32(0, true) !== LOCAL_SIGNATURE) {
    throw new ArchiveReadError('Archive entry header is damaged.');
  }
  const dataStart =
    entry.localOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);

  const raw = await file.slice(dataStart, dataStart + entry.compressedSize).arrayBuffer();
  return entry.method === METHOD_DEFLATE ? inflateRaw(raw) : raw;
}

/** Reads and parses `manifest.json`. Throws ArchiveReadError on anything unusable. */
export async function readArchiveManifest(file: Blob): Promise<ArchiveManifest> {
  const central = await readCentralDirectory(file);
  const manifestEntry = central.find((e) => e.path === 'manifest.json');
  if (!manifestEntry) {
    throw new ArchiveReadError('No manifest.json - this is a zip, but not an ERP archive.');
  }

  const bytes = await readEntry(file, manifestEntry);
  let manifest: ArchiveManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ArchiveReadError('manifest.json is not readable JSON.');
  }

  if (manifest.format !== 'rvparchive') {
    throw new ArchiveReadError(`Unrecognised archive format "${manifest.format}".`);
  }
  return manifest;
}

/** Row counts per folder, for the preflight summary. */
export function summariseEntries(manifest: ArchiveManifest) {
  const bucket = { masters: 0, tables: 0, counters: 0 };
  let populated = 0;
  for (const [path, entry] of Object.entries(manifest.entries)) {
    if (entry.rows > 0) populated += 1;
    if (path.startsWith('masters/')) bucket.masters += entry.rows;
    else if (path.startsWith('counters/')) bucket.counters += entry.rows;
    else bucket.tables += entry.rows;
  }
  return { ...bucket, populated, files: Object.keys(manifest.entries).length };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
