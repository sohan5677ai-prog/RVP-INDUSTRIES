/**
 * Read a backup back (Phase 9, plan item 2).
 *
 *   node scripts/restore-database.mjs --list
 *   node scripts/restore-database.mjs --verify              # newest backup
 *   node scripts/restore-database.mjs --verify --file <f>
 *   node scripts/restore-database.mjs --into <url> --confirm=<host>
 *
 * ---------------------------------------------------------------------------
 * `--verify` is the one to run every month
 *
 * It decrypts the dump and reads its table of contents with `pg_restore -l`,
 * which proves three things without touching any database: the key still
 * decrypts, the file is not corrupt, and the dump actually contains the
 * tables it should. That is a restore test somebody will actually perform -
 * a procedure that needs a spare database and an hour is a procedure that
 * gets skipped until the day it is needed.
 *
 * It is not the same as a full restore, and the runbook says so. It does not
 * prove the data restores cleanly into a live schema. It does prove the file
 * is readable, which is the failure that actually happens: a key that was
 * lost, or a dump that has been silently truncated by a sync client.
 *
 * `--into` does the real thing, and refuses to point at production. Restoring
 * over the live database is not a recovery step anyone should be able to take
 * by accident at 2am.
 * ---------------------------------------------------------------------------
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import 'dotenv/config';
import { decrypt, BackupDecryptError } from '../dist/lib/backupCrypto.js';

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=').slice(1).join('=');
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const has = (name) => process.argv.includes(`--${name}`);

function findBin(exe) {
  const env = process.env[exe === 'pg_restore.exe' ? 'PG_RESTORE' : 'PG_DUMP'];
  if (env && existsSync(env)) return env;
  for (const root of ['C:/Program Files/PostgreSQL', 'C:/Program Files (x86)/PostgreSQL']) {
    if (!existsSync(root)) continue;
    for (const v of readdirSync(root).sort((a, b) => Number(b) - Number(a))) {
      const p = path.join(root, v, 'bin', exe);
      if (existsSync(p)) return p;
    }
  }
  return exe.replace('.exe', '');
}

const DEST = process.env.BACKUP_DEST_DIR
  || (process.env.OneDrive ? path.join(process.env.OneDrive, 'RVP-Backups') : null);
const KEY = process.env.BACKUP_ENCRYPTION_KEY ?? '';
const PG_RESTORE = findBin('pg_restore.exe');
const mb = (n) => (n / 1048576).toFixed(1);
const die = (msg) => {
  console.error(`\nREFUSED: ${msg}`);
  process.exit(1);
};

function backups() {
  if (!DEST || !existsSync(DEST)) return [];
  return readdirSync(DEST)
    .filter((f) => /^rvp-.*\.dump\.enc$/.test(f))
    .map((f) => ({ name: f, full: path.join(DEST, f), stat: statSync(path.join(DEST, f)) }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
}

/* -------------------------------------------------------------- list ---- */

if (has('list') || process.argv.length === 2) {
  const all = backups();
  console.log(`backups in ${DEST ?? '(no destination configured)'}\n`);
  if (all.length === 0) console.log('  none. Run scripts/backup-database.mjs');
  for (const b of all) {
    const age = ((Date.now() - b.stat.mtimeMs) / 86400000).toFixed(1);
    console.log(`  ${b.name}  ${mb(b.stat.size).padStart(7)} MB  ${age.padStart(5)}d old`);
  }
  console.log('\n  --verify            check the newest one is readable');
  console.log('  --into <url>        restore into a NON-production database');
  process.exit(0);
}

/* ------------------------------------------------------------ resolve --- */

const chosen = arg('file') ?? backups()[0]?.full;
if (!chosen) die('no backup found. Run scripts/backup-database.mjs first.');
if (!existsSync(chosen)) die(`no such file: ${chosen}`);
if (!KEY) die('BACKUP_ENCRYPTION_KEY is not set, so nothing can be decrypted.');

console.log(`backup : ${path.basename(chosen)}  ${mb(statSync(chosen).size)} MB`);

let plain;
try {
  plain = decrypt(readFileSync(chosen), KEY);
} catch (err) {
  if (err instanceof BackupDecryptError) die(err.message);
  throw err;
}
console.log(`decrypted: ${mb(plain.length)} MB`);

const temp = path.join(tmpdir(), `rvp-restore-${Date.now()}.dump`);
writeFileSync(temp, plain);

try {
  /* ------------------------------------------------------------ verify -- */

  if (has('verify') || !arg('into')) {
    const toc = execFileSync(PG_RESTORE, ['--list', temp], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const lines = toc.split('\n');
    const tables = lines.filter((l) => / TABLE DATA /.test(l));
    const indexes = lines.filter((l) => / INDEX /.test(l));
    console.log(`\nthe dump is readable:`);
    console.log(`  ${tables.length} table(s) with data`);
    console.log(`  ${indexes.length} index(es)`);

    // A dump that decrypts but contains almost nothing is the quiet failure
    // this check exists to catch.
    if (tables.length < 50) {
      die(`only ${tables.length} tables with data. This database has ~96 - the dump looks incomplete.`);
    }
    for (const want of ['party', 'payment', 'saleorder', 'stockin']) {
      if (!toc.toLowerCase().includes(` ${want} `)) {
        console.warn(`  WARNING: no "${want}" table in the dump`);
      }
    }
    console.log('\nVERIFIED. The key works, the file is intact, and the tables are there.');
    console.log('This is not a full restore test - see docs/security/RUNBOOK.md.');
    process.exit(0);
  }

  /* ----------------------------------------------------------- restore -- */

  const into = arg('into');
  const confirm = arg('confirm') ?? '';
  const identity = (url) => {
    try {
      const u = new URL(url);
      return `${u.host}${u.pathname}`;
    } catch {
      return null;
    }
  };

  const target = identity(into);
  if (!target) die('--into is not a URL this script can parse.');

  for (const [label, url] of [['DATABASE_URL', process.env.DATABASE_URL], ['DIRECT_URL', process.env.DIRECT_URL]]) {
    const live = identity(url ?? '');
    if (live && live === target) {
      die(
        `--into points at the same host and database as ${label}. That is the live system.\n` +
          'Restore into a scratch database and promote it, rather than overwriting production in place.'
      );
    }
  }
  if (confirm !== new URL(into).host) {
    die(
      `--confirm must match the target host.\n  target : ${new URL(into).host}\n  passed : ${confirm || '(nothing)'}`
    );
  }

  console.log(`\nrestoring into ${target} ...`);
  execFileSync(
    PG_RESTORE,
    ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--dbname', into, temp],
    { stdio: ['ignore', 'inherit', 'inherit'], timeout: 60 * 60 * 1000 }
  );
  console.log('restore finished.');
} finally {
  if (existsSync(temp)) unlinkSync(temp);
}
