/**
 * Minimal streaming ZIP writer, plus the spooler that feeds it.
 *
 * Entries are spooled to temp files first so their CRC and sizes are known
 * before the local header is written - which removes the need for data
 * descriptors and keeps the writer to one straightforward pass. It also bounds
 * memory: a 500k-row table never exists in RAM, only on disk.
 *
 * No zip64. Sizes must fit in 32 bits, which caps one archive at 4 GB - roughly
 * two orders of magnitude above a realistic FY.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { Transform, Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from './crc32.js';
import { createEntryCipher } from './crypto.js';

export const METHOD_STORE = 0 as const;
export const METHOD_DEFLATE = 8 as const;

export interface ZipEntry {
  /** Path inside the zip. Forward slashes, no leading slash. */
  path: string;
  /** Temp file holding exactly the bytes to store. */
  tmpPath: string;
  method: typeof METHOD_STORE | typeof METHOD_DEFLATE;
  /** CRC-32 of the data as the zip sees it before compression. */
  crc: number;
  /** Bytes actually stored. */
  compressedSize: number;
  /** Bytes before compression. Equals compressedSize when method is STORE. */
  uncompressedSize: number;
}

export interface SpoolResult {
  entry: ZipEntry;
  /** SHA-256 of the STORED bytes, so integrity is checkable before decrypting. */
  sha256: string;
  /** Bytes of NDJSON before compression or encryption. */
  plainBytes: number;
  /** GCM parameters, present only for encrypted entries. */
  iv?: string;
  tag?: string;
}

/** Passes data through untouched while feeding it to a set of accumulators. */
function tap(onChunk: (chunk: Buffer) => void): Transform {
  return new Transform({
    transform(chunk, _enc, cb) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      onChunk(buf);
      cb(null, buf);
    },
  });
}

/**
 * Writes one archive entry to a temp file, returning everything the zip writer
 * and the manifest need.
 *
 * Two pipelines, because ZIP's CRC covers the data *as stored before
 * compression*, and encryption moves where that point is:
 *
 *   plain:     chunks -> [crc] -> deflate -> [sha] -> file   (method DEFLATE)
 *   encrypted: chunks -> deflate -> cipher -> [crc + sha] -> file   (method STORE)
 *
 * Encrypted entries are STOREd because their bytes are ciphertext - a zip reader
 * that tried to inflate them would fail. Compression still happens, just inside
 * the envelope, and before encryption where it can still do some good.
 */
export async function spoolEntry(opts: {
  path: string;
  tmpDir: string;
  chunks: AsyncIterable<string | Buffer>;
  /** When present the entry is encrypted; when absent it is plain DEFLATE. */
  key?: Buffer;
}): Promise<SpoolResult> {
  const tmpPath = path.join(opts.tmpDir, `${crypto.randomBytes(8).toString('hex')}.part`);
  const out = fs.createWriteStream(tmpPath);

  let plainBytes = 0;
  let crc = 0;
  let storedBytes = 0;
  const sha = crypto.createHash('sha256');

  const plainCount = tap((c) => { plainBytes += c.length; });
  const crcTap = tap((c) => { crc = crc32(c, crc); });
  const storedTap = tap((c) => { storedBytes += c.length; sha.update(c); });

  const source = Readable.from(opts.chunks);

  let method: ZipEntry['method'];
  let iv: string | undefined;
  let tag: string | undefined;

  if (opts.key) {
    method = METHOD_STORE;
    const { iv: ivBuf, cipher } = createEntryCipher(opts.key);
    iv = ivBuf.toString('base64');
    await pipeline(
      source, plainCount, zlib.createDeflateRaw(), cipher, crcTap, storedTap, out as Writable,
    );
    tag = cipher.getAuthTag().toString('base64');
  } else {
    method = METHOD_DEFLATE;
    await pipeline(
      source, plainCount, crcTap, zlib.createDeflateRaw(), storedTap, out as Writable,
    );
  }

  return {
    entry: {
      path: opts.path,
      tmpPath,
      method,
      crc,
      compressedSize: storedBytes,
      // For DEFLATE the zip needs the pre-compression size; for the encrypted
      // STORE case the stored bytes *are* the entry as far as the zip knows.
      uncompressedSize: method === METHOD_DEFLATE ? plainBytes : storedBytes,
    },
    sha256: sha.digest('hex'),
    plainBytes,
    iv,
    tag,
  };
}

/** DOS date/time, as zip stores it: local wall-clock, 2-second resolution. */
function dosDateTime(at: Date, offsetMs: number): { time: number; date: number } {
  const d = new Date(at.getTime() + offsetMs);
  const time =
    (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (Math.floor(d.getUTCSeconds() / 2));
  const date =
    ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function localHeader(e: ZipEntry, dt: { time: number; date: number }): Buffer {
  const name = Buffer.from(e.path, 'utf8');
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0); // local file header signature
  head.writeUInt16LE(20, 4); // version needed
  head.writeUInt16LE(0, 6); // flags
  head.writeUInt16LE(e.method, 8);
  head.writeUInt16LE(dt.time, 10);
  head.writeUInt16LE(dt.date, 12);
  head.writeUInt32LE(e.crc, 14);
  head.writeUInt32LE(e.compressedSize, 18);
  head.writeUInt32LE(e.uncompressedSize, 22);
  head.writeUInt16LE(name.length, 26);
  head.writeUInt16LE(0, 28); // extra field length
  return Buffer.concat([head, name]);
}

function centralHeader(e: ZipEntry, offset: number, dt: { time: number; date: number }): Buffer {
  const name = Buffer.from(e.path, 'utf8');
  const head = Buffer.alloc(46);
  head.writeUInt32LE(0x02014b50, 0); // central directory header signature
  head.writeUInt16LE(20, 4); // version made by
  head.writeUInt16LE(20, 6); // version needed
  head.writeUInt16LE(0, 8); // flags
  head.writeUInt16LE(e.method, 10);
  head.writeUInt16LE(dt.time, 12);
  head.writeUInt16LE(dt.date, 14);
  head.writeUInt32LE(e.crc, 16);
  head.writeUInt32LE(e.compressedSize, 20);
  head.writeUInt32LE(e.uncompressedSize, 24);
  head.writeUInt16LE(name.length, 28);
  head.writeUInt16LE(0, 30); // extra
  head.writeUInt16LE(0, 32); // comment
  head.writeUInt16LE(0, 34); // disk number start
  head.writeUInt16LE(0, 36); // internal attributes
  head.writeUInt32LE(0, 38); // external attributes
  head.writeUInt32LE(offset, 42); // relative offset of local header
  return Buffer.concat([head, name]);
}

function endOfCentralDirectory(count: number, cdSize: number, cdOffset: number): Buffer {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(count, 8); // entries on this disk
  eocd.writeUInt16LE(count, 10); // entries total
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment length
  return eocd;
}

/**
 * Assembles the final zip from spooled entries and deletes their temp files.
 * Entry order is preserved, so `manifest.json` can be made readable first.
 */
export async function writeZip(outPath: string, entries: ZipEntry[], at: Date): Promise<number> {
  const dt = dosDateTime(at, IST_OFFSET_MS);
  const out = fs.createWriteStream(outPath);
  // One `pipeline(..., out, { end: false })` per entry attaches its own error /
  // close / finish / end handlers, and the header writes add more, so ~50 entries
  // trips Node's leak warning. They are real, transient listeners on a stream
  // whose lifetime we control, so the cap is simply lifted.
  out.setMaxListeners(0);

  const write = (buf: Buffer) =>
    new Promise<void>((resolve, reject) =>
      out.write(buf, (err) => (err ? reject(err) : resolve())),
    );

  let offset = 0;
  const central: Buffer[] = [];

  for (const e of entries) {
    if (e.compressedSize > 0xffffffff || e.uncompressedSize > 0xffffffff) {
      throw new Error(`${e.path} exceeds 4 GB - zip64 is not implemented`);
    }
    const head = localHeader(e, dt);
    await write(head);
    offset += head.length;

    central.push(centralHeader(e, offset - head.length, dt));

    await pipeline(fs.createReadStream(e.tmpPath), out, { end: false });
    offset += e.compressedSize;
  }

  const cdOffset = offset;
  const cd = Buffer.concat(central);
  await write(cd);
  await write(endOfCentralDirectory(entries.length, cd.length, cdOffset));

  await new Promise<void>((resolve, reject) => {
    out.end((err?: NodeJS.ErrnoException | null) => (err ? reject(err) : resolve()));
  });

  await Promise.all(entries.map((e) => fsp.rm(e.tmpPath, { force: true })));

  return cdOffset + cd.length + 22;
}
