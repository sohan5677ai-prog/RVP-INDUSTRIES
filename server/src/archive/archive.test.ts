import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { encodeRow, canonicalJson } from './serialize.js';
import { crc32 } from './crc32.js';
import { spoolEntry, writeZip, METHOD_STORE, METHOD_DEFLATE } from './zip.js';
import { deriveKey, newSalt, createEntryDecipher } from './crypto.js';
import { sealManifest, verifySeal, type Manifest } from './manifest.js';
import {
  ARCHIVE_MODELS,
  ARCHIVE_TABLES,
  EXCLUDED,
  entryPath,
  whereForFy,
  stripOmitted,
} from './registry.js';
import { istFinancialYearRange, fyLabelLong, fyLabelShort } from '../lib/istDate.js';

let tmpDir: string;
beforeAll(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rvp-archive-test-'));
});
afterAll(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ── A minimal zip reader, used to prove the writer round-trips. It is also the
// skeleton the mount pipeline will need, so it lives here rather than inline. ──
interface ReadEntry { path: string; method: number; crc: number; data: Buffer }

function readZip(buf: Buffer): ReadEntry[] {
  // Locate the end-of-central-directory record by scanning back for its
  // signature (no zip comment is ever written, so it is the last 22 bytes).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  const entries: ReadEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory header');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('bad local header');
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;

    entries.push({ path: name, method, crc, data: buf.subarray(dataStart, dataStart + compSize) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

describe('canonical row encoding', () => {
  it('renders Decimal as a string so paise survive', () => {
    const line = encodeRow({ amount: new Prisma.Decimal('48210993.05') });
    expect(line).toBe('{"amount":"48210993.05"}');
    // The failure this rule exists to prevent: JSON.stringify would emit a
    // number, and a value this size loses its last paise on the way back.
    expect(line).not.toContain('48210993.05,');
  });

  it('keeps precision past what a float can hold', () => {
    const big = '12345678901234567.89';
    expect(encodeRow({ v: new Prisma.Decimal(big) })).toBe(`{"v":"${big}"}`);
    // The same value through a JS number comes back as 12345678901234568 -
    // this is the loss the string rule exists to prevent.
    expect(String(Number(big))).not.toBe(big);
  });

  it('renders DateTime as ISO-8601 UTC', () => {
    expect(encodeRow({ d: new Date('2026-03-31T18:30:00.000Z') }))
      .toBe('{"d":"2026-03-31T18:30:00.000Z"}');
  });

  it('sorts keys so two exports of one year are byte-identical', () => {
    expect(encodeRow({ b: 1, a: 2 })).toBe(encodeRow({ a: 2, b: 1 }));
  });

  it('collapses undefined to explicit null and recurses into Json columns', () => {
    expect(encodeRow({ a: undefined, j: { z: 1, y: [new Prisma.Decimal('1.50')] } }))
      .toBe('{"a":null,"j":{"y":["1.5"],"z":1}}');
  });
});

describe('crc32', () => {
  it('matches the known IEEE check value', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('is stable when fed in chunks, as the spooler does', () => {
    const whole = crc32(Buffer.from('hello world'));
    const chunked = crc32(Buffer.from('world'), crc32(Buffer.from('hello ')));
    expect(chunked).toBe(whole);
  });
});

describe('manifest seal', () => {
  const base = {
    format: 'rvparchive', formatVersion: 1, schemaVersion: 17, erpCommit: null,
    company: { name: 'RVP INDUSTRIES', gstin: null },
    financialYear: { fyStart: 2025, label: '2025-26', from: 'x', to: 'y' },
    exportedAt: 'now', exportedAtIst: 'now', exportedBy: { userId: 'u', username: 'sohan' },
    encryption: { enabled: false }, entries: {},
    totals: { trialBalanceDr: '0', trialBalanceCr: '0', rows: 0 },
  } as unknown as Manifest;

  it('verifies a sealed manifest', () => {
    expect(verifySeal(sealManifest(base))).toBe(true);
  });

  it('rejects a manifest edited after sealing', () => {
    const tampered = sealManifest(base);
    tampered.totals.rows = 999;
    expect(verifySeal(tampered)).toBe(false);
  });
});

describe('zip round-trip', () => {
  const rows = Array.from({ length: 5_000 }, (_, i) =>
    encodeRow({ id: `row${i}`, amount: new Prisma.Decimal(`${i}.25`), at: new Date(0) }) + '\n',
  );
  const plaintext = Buffer.from(rows.join(''), 'utf8');

  it('writes a plain DEFLATE entry that inflates back to the original bytes', async () => {
    const spooled = await spoolEntry({
      path: 'tables/010_PurchaseOrder.ndjson',
      tmpDir,
      chunks: (async function* () { for (const r of rows) yield r; })(),
    });
    expect(spooled.entry.method).toBe(METHOD_DEFLATE);
    expect(spooled.plainBytes).toBe(plaintext.length);

    const zipPath = path.join(tmpDir, 'plain.rvparchive');
    await writeZip(zipPath, [spooled.entry], new Date('2026-04-01T13:12:44Z'));

    const [entry] = readZip(await fsp.readFile(zipPath));
    expect(entry.path).toBe('tables/010_PurchaseOrder.ndjson');
    const inflated = zlib.inflateRawSync(entry.data);
    expect(inflated.equals(plaintext)).toBe(true);
    // ZIP's CRC covers the data before compression.
    expect(entry.crc).toBe(crc32(plaintext));
  });

  it('writes an encrypted STORE entry that decrypts and inflates back', async () => {
    const salt = newSalt();
    const key = await deriveKey('a-long-enough-passphrase', salt);
    const spooled = await spoolEntry({
      path: 'tables/020_StockIn.ndjson',
      tmpDir,
      chunks: (async function* () { for (const r of rows) yield r; })(),
      key,
    });
    expect(spooled.entry.method).toBe(METHOD_STORE);
    expect(spooled.iv).toBeTruthy();
    expect(spooled.tag).toBeTruthy();

    const zipPath = path.join(tmpDir, 'enc.rvparchive');
    await writeZip(zipPath, [spooled.entry], new Date('2026-04-01T13:12:44Z'));

    const [entry] = readZip(await fsp.readFile(zipPath));
    // sha256 in the manifest is over the STORED bytes, so integrity is
    // checkable before the passphrase is known.
    expect(crypto.createHash('sha256').update(entry.data).digest('hex')).toBe(spooled.sha256);

    const decipher = createEntryDecipher(
      key, Buffer.from(spooled.iv!, 'base64'), Buffer.from(spooled.tag!, 'base64'),
    );
    const deflated = Buffer.concat([decipher.update(entry.data), decipher.final()]);
    expect(zlib.inflateRawSync(deflated).equals(plaintext)).toBe(true);
  });

  it('fails the GCM tag when ciphertext is tampered with', async () => {
    const salt = newSalt();
    const key = await deriveKey('a-long-enough-passphrase', salt);
    const spooled = await spoolEntry({
      path: 'x.ndjson', tmpDir, chunks: (async function* () { yield 'hello\n'; })(), key,
    });
    const stored = await fsp.readFile(spooled.entry.tmpPath);
    stored[0] ^= 0xff;

    const decipher = createEntryDecipher(
      key, Buffer.from(spooled.iv!, 'base64'), Buffer.from(spooled.tag!, 'base64'),
    );
    expect(() => Buffer.concat([decipher.update(stored), decipher.final()])).toThrow();
    await fsp.rm(spooled.entry.tmpPath, { force: true });
  });

  it('preserves entry order so manifest.json is readable first', async () => {
    const mk = (p: string) =>
      spoolEntry({ path: p, tmpDir, chunks: (async function* () { yield `${p}\n`; })() });
    const manifest = await mk('manifest.json');
    const table = await mk('tables/010_PurchaseOrder.ndjson');

    const zipPath = path.join(tmpDir, 'ordered.rvparchive');
    await writeZip(zipPath, [manifest.entry, table.entry], new Date());
    expect(readZip(await fsp.readFile(zipPath)).map((e) => e.path))
      .toEqual(['manifest.json', 'tables/010_PurchaseOrder.ndjson']);
  });
});

describe('model registry', () => {
  it('covers every model in the Prisma schema exactly once', async () => {
    const schema = await fsp.readFile(
      path.join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8',
    );
    const inSchema = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]).sort();
    const classified = [...ARCHIVE_MODELS, ...EXCLUDED].map((m) => m.name).sort();

    // A model added to the schema but not classified would be silently dropped
    // from every archive - the one failure mode that is invisible until a
    // restore years later.
    expect(classified).toEqual(inSchema);
  });

  it('gives every archived model a unique entry path', () => {
    const paths = ARCHIVE_MODELS.map(entryPath);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('orders each table after everything it references', () => {
    const order = new Map(ARCHIVE_TABLES.map((m) => [m.name, m.order]));
    // A handful of FK edges that must hold, spot-checked from schema.prisma.
    const edges: Array<[string, string]> = [
      ['StockIn', 'PurchaseOrder'], ['Purchase', 'StockIn'],
      ['WeightVerification', 'Purchase'], ['SaleDispatch', 'SaleOrder'],
      ['SaleAllocation', 'SaleOrder'], ['JournalLine', 'JournalEntry'],
      ['LoanRepayment', 'BankLoan'], ['Payment', 'HamaliVerification'],
      ['Payment', 'JournalEntry'], ['Receipt', 'SaleDispatch'],
      ['CreditNote', 'SaleDispatch'], ['EmailLog', 'CreditNote'],
    ];
    for (const [child, parent] of edges) {
      expect(order.get(child), `${child} must come after ${parent}`)
        .toBeGreaterThan(order.get(parent)!);
    }
  });

  it('scopes transactional models by their own business date', () => {
    const range = istFinancialYearRange(2025);
    const po = ARCHIVE_MODELS.find((m) => m.name === 'PurchaseOrder')!;
    expect(whereForFy(po, 2025, range)).toEqual({ poDate: { gte: range.from, lt: range.to } });
  });

  it('scopes Purchase through StockIn, not its own purchaseDate', () => {
    const range = istFinancialYearRange(2025);
    const purchase = ARCHIVE_MODELS.find((m) => m.name === 'Purchase')!;
    // purchaseDate is operator-settable and drifts past 31 March; following it
    // would split the seed value from the supplier payable across two years.
    expect(whereForFy(purchase, 2025, range))
      .toEqual({ stockIn: { arrivalDate: { gte: range.from, lt: range.to } } });
  });

  it('snapshots masters and spanning models whole', () => {
    const range = istFinancialYearRange(2025);
    for (const name of ['Party', 'Account', 'BankLoan', 'SiloInventory']) {
      const m = ARCHIVE_MODELS.find((x) => x.name === name)!;
      expect(whereForFy(m, 2025, range), name).toBeNull();
    }
  });

  it('uses each counter’s own FY label format', () => {
    const range = istFinancialYearRange(2025);
    const po = ARCHIVE_MODELS.find((m) => m.name === 'PoSerialCounter')!;
    const note = ARCHIVE_MODELS.find((m) => m.name === 'NoteSerialCounter')!;
    // poNumber.computeFY writes "25-26"; invoice.indianFinancialYear writes
    // "2025-26". Reading either with the other's format silently returns zero
    // counter rows, and a re-mounted year would then reuse live numbers.
    expect(whereForFy(po, 2025, range)).toEqual({ fy: '25-26' });
    expect(whereForFy(note, 2025, range)).toEqual({ fy: '2025-26' });
  });

  it('strips password hashes and GSP credentials', () => {
    const user = ARCHIVE_MODELS.find((m) => m.name === 'User')!;
    expect(stripOmitted(user, { id: 'u', username: 'sohan', password: '$2a$10$x' }))
      .toEqual({ id: 'u', username: 'sohan' });

    const profile = ARCHIVE_MODELS.find((m) => m.name === 'CompanyProfile')!;
    const stripped = stripOmitted(profile, { name: 'RVP', taxproGstPass: 'secret' });
    expect(stripped).not.toHaveProperty('taxproGstPass');
  });
});

describe('financial-year boundaries', () => {
  it('runs midnight IST on 1 April to midnight IST the next 1 April', () => {
    const { from, to } = istFinancialYearRange(2025);
    expect(from.toISOString()).toBe('2025-03-31T18:30:00.000Z');
    expect(to.toISOString()).toBe('2026-03-31T18:30:00.000Z');
  });

  it('puts a voucher just after midnight IST on 1 April in the new year only', () => {
    const justAfter = new Date('2025-03-31T18:30:01.000Z'); // 00:00:01 IST, 1 Apr
    expect(justAfter >= istFinancialYearRange(2025).from).toBe(true);
    expect(justAfter < istFinancialYearRange(2024).to).toBe(false);
  });

  it('labels years the way each numbering scheme already does', () => {
    expect(fyLabelLong(2025)).toBe('2025-26');
    expect(fyLabelShort(2025)).toBe('25-26');
  });
});

describe('canonicalJson', () => {
  it('is stable across key insertion order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } }))
      .toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
});

// Keeps the unused-import linter honest about fs, which the reader uses lazily.
void fs;
