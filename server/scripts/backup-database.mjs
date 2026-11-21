/**
 * Daily encrypted database backup (Phase 9, plan item 1).
 *
 *   node scripts/backup-database.mjs            # take a backup now
 *   node scripts/backup-database.mjs --check    # show config, take nothing
 *
 * ---------------------------------------------------------------------------
 * Why this runs here and not on Render
 *
 * Render's filesystem is ephemeral, its cron is a paid add-on, and `pg_dump`
 * is not in the Node image. So the backup runs on a machine you control,
 * driven by Windows Task Scheduler. `pg_dump` 18.3 is already installed on
 * this one; it is simply not on PATH, which is what PG_DUMP below handles.
 *
 * It dumps through DIRECT_URL (port 5432), never DATABASE_URL (6543). The
 * pooled endpoint is pgbouncer in transaction mode, which cannot hold the
 * session state `pg_dump` needs - pointing this at the pooler produces a dump
 * that fails at restore, which is the worst time to find out.
 *
 * Custom format (-Fc), because that is what `pg_restore` takes, and it lets a
 * restore pick single tables instead of being all-or-nothing.
 * ---------------------------------------------------------------------------
 *
 * THE RULE THAT MATTERS MOST: retention never runs unless the new backup was
 * written and verified. The classic way to lose everything is a script that
 * prunes old backups first, then fails to write the new one, every night,
 * quietly, until the day you need a restore.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import 'dotenv/config';
import { encrypt, decrypt, generateKey, describeKeyStrength } from '../dist/lib/backupCrypto.js';

const CHECK_ONLY = process.argv.includes('--check');

/** Where pg_dump lives when it is not on PATH. */
function findPgDump() {
  if (process.env.PG_DUMP && existsSync(process.env.PG_DUMP)) return process.env.PG_DUMP;
  const roots = ['C:/Program Files/PostgreSQL', 'C:/Program Files (x86)/PostgreSQL'];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    // Highest version first: a newer pg_dump can dump an older server, not
    // the other way round.
    for (const v of readdirSync(root).sort((a, b) => Number(b) - Number(a))) {
      const p = path.join(root, v, 'bin', 'pg_dump.exe');
      if (existsSync(p)) return p;
    }
  }
  return 'pg_dump';
}

const DEST = process.env.BACKUP_DEST_DIR
  || (process.env.OneDrive ? path.join(process.env.OneDrive, 'RVP-Backups') : null);
const KEY = process.env.BACKUP_ENCRYPTION_KEY ?? '';
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS ?? 30);
const DIRECT = process.env.DIRECT_URL;
const PG_DUMP = findPgDump();

const mb = (n) => (n / 1048576).toFixed(1);
const die = (msg) => {
  console.error(`\nFAILED: ${msg}`);
  process.exit(1);
};

/* ------------------------------------------------------------- config ---- */

console.log('configuration');
console.log(`  pg_dump        : ${PG_DUMP}`);
console.log(`  source         : ${DIRECT ? DIRECT.replace(/\/\/[^@]*@/, '//***@') : '(DIRECT_URL not set)'}`);
console.log(`  destination    : ${DEST ?? '(not set)'}`);
console.log(`  retention      : ${RETENTION_DAYS} days`);
console.log(`  encryption key : ${describeKeyStrength(KEY)}`);

if (describeKeyStrength(KEY) === 'missing') {
  console.error(
    '\nFAILED: BACKUP_ENCRYPTION_KEY is not set, and an unencrypted dump of this database ' +
      'holds every bank account, GSTIN and password hash.\n\n' +
      'Add this to server/.env and keep a copy somewhere OFF this machine -\n' +
      'losing it means the backups cannot be restored:\n\n' +
      `  BACKUP_ENCRYPTION_KEY=${generateKey()}\n`
  );
  process.exit(1);
}
if (describeKeyStrength(KEY) === 'weak') {
  console.warn('  (that key is not 64 hex characters - usable, but weaker than a generated one)');
}
if (!DIRECT) die('DIRECT_URL is not set. pg_dump cannot use the pooled DATABASE_URL.');
if (!DEST) die('Set BACKUP_DEST_DIR, or run where OneDrive is configured.');
if (DIRECT.includes(':6543')) {
  die('DIRECT_URL points at the pooled port 6543. pg_dump needs the direct port, 5432.');
}

if (CHECK_ONLY) {
  console.log('\n--check: nothing was taken.');
  process.exit(0);
}

/* -------------------------------------------------------------- dump ----- */

mkdirSync(DEST, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const temp = path.join(tmpdir(), `rvp-${stamp}.dump`);
const target = path.join(DEST, `rvp-${stamp}.dump.enc`);

try {
  console.log('\ndumping...');
  const started = Date.now();
  execFileSync(PG_DUMP, ['--format=custom', '--no-owner', '--no-privileges', '--file', temp, DIRECT], {
    stdio: ['ignore', 'inherit', 'inherit'],
    // A dump of this size should be minutes, not hours; a hang must not keep
    // the scheduled task alive until the next one starts.
    timeout: 30 * 60 * 1000,
  });

  const plain = readFileSync(temp);
  if (plain.length < 1024) die(`the dump is only ${plain.length} bytes, which cannot be right.`);

  // Verify before trusting it: encrypt, then decrypt what was encrypted and
  // compare. A backup nobody has read back is a hope, not a backup.
  const sealed = encrypt(plain, KEY);
  if (!decrypt(sealed, KEY).equals(plain)) {
    die('the encrypted dump did not decrypt back to the same bytes. Nothing was written.');
  }

  writeFileSync(target, sealed);
  const onDisk = statSync(target).size;
  console.log(
    `wrote ${path.basename(target)}  ${mb(onDisk)} MB  in ${((Date.now() - started) / 1000).toFixed(0)}s`
  );
  console.log(`  (dump ${mb(plain.length)} MB before encryption)`);

  /* --------------------------------------------------------- retention --- */

  // Only now, with a verified new backup on disk.
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
  const mine = readdirSync(DEST).filter((f) => /^rvp-.*\.dump\.enc$/.test(f));
  let removed = 0;
  for (const f of mine) {
    const p = path.join(DEST, f);
    if (p === target) continue;
    if (statSync(p).mtimeMs < cutoff) {
      unlinkSync(p);
      removed++;
    }
  }
  const kept = readdirSync(DEST).filter((f) => /^rvp-.*\.dump\.enc$/.test(f));
  console.log(
    `retention: removed ${removed} older than ${RETENTION_DAYS}d, ${kept.length} backup(s) kept`
  );

  if (kept.length === 1) {
    console.log('\nThis is the only backup. Test a restore before you rely on it:');
    console.log('  node scripts/restore-database.mjs --list');
  }
} finally {
  if (existsSync(temp)) unlinkSync(temp);
}
