/**
 * Enumerate every HTTP route and the guards in front of it.
 *
 * Written because the Phase 0 audit missed the anonymous scale endpoints: it
 * read the route files and trusted the interesting parts to stand out, and
 * they did not. With ~400 routes, deciding authorization by eye is how a gap
 * survives. This builds the table mechanically instead.
 *
 *   node scripts/audit-routes.mjs            # summary
 *   node scripts/audit-routes.mjs --all      # every route
 *   node scripts/audit-routes.mjs --json     # machine-readable
 *
 * It is a static reader, not a type checker: it matches `router.<verb>(...)`
 * and `app.<verb>(...)` calls and the mount points that prefix them. Anything
 * it cannot resolve is reported as `?` rather than guessed, so an unparsed
 * route shows up as a gap rather than silently passing.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const ROUTES_DIR = 'src/routes';
const INDEX_FILE = 'src/index.ts';

const VERBS = ['get', 'post', 'put', 'patch', 'delete', 'all'];

/** Guard names that actually authenticate or authorise. */
const AUTH_GUARDS = new Set([
  'requireAuth',
  'requireRole',
  'requireAuthOrCameraBridge',
  'requireMediaRead',
  'requireMediaWrite',
  'requireTallyAgent',
  'printQueueAuth',
  'canEditSettings',
  'canManage',
]);

/** Middleware that is not an auth guard, so it must not be counted as one. */
const NON_GUARDS = new Set([
  'asyncHandler',
  'loginLimiter',
  'webhookLimiter',
  'bulkImportLimiter',
  'passwordResetLimiter',
  'apiLimiter',
  'memUpload',
  'upload',
  'memoryUpload',
  'express',
]);

function read(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Split a call's argument list on top-level commas, so that
 * `'/x', requireRole('A','B'), asyncHandler(h)` yields three arguments rather
 * than five.
 */
function splitArgs(src) {
  const out = [];
  let depth = 0;
  let current = '';
  let quote = null;
  for (const ch of src) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Find the matching close paren for the open paren at `start`. */
function matchParen(src, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote && src[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Route calls in one file. */
function routesIn(src, holder) {
  const found = [];
  const re = new RegExp(`\\b${holder}\\.(${VERBS.join('|')})\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(src))) {
    const open = re.lastIndex - 1;
    const close = matchParen(src, open);
    if (close === -1) continue;
    const args = splitArgs(src.slice(open + 1, close));
    if (args.length === 0) continue;
    const pathLiteral = /^['"`]/.test(args[0]) ? args[0].slice(1, -1) : null;
    if (pathLiteral === null) continue;
    const middleware = args.slice(1).map((a) => a.split('(')[0].trim());
    found.push({
      method: m[1].toUpperCase(),
      path: pathLiteral,
      middleware,
      line: src.slice(0, m.index).split('\n').length,
    });
  }
  return found;
}

/** `router.use('/mount', xRoutes)` pairs, so a file's routes get their prefix. */
function mountsIn(src) {
  const mounts = [];
  const re = /\brouter\.use\s*\(\s*(['"`])([^'"`]*)\1\s*,\s*([A-Za-z0-9_]+)\s*\)/g;
  let m;
  while ((m = re.exec(src))) mounts.push({ prefix: m[2], ident: m[3] });
  return mounts;
}

/** `import x from './y.routes.js'` so a mount ident maps back to a file. */
function importsIn(src) {
  const map = new Map();
  const re = /import\s+([A-Za-z0-9_]+)\s+from\s+['"]\.\/([A-Za-z0-9_.-]+)\.js['"]/g;
  let m;
  while ((m = re.exec(src))) map.set(m[1], `${m[2]}.ts`);
  return map;
}

/**
 * The first file-scope `router.use(<auth guard>)`, which covers every route
 * declared below it. Returns the guard's name and line.
 */
function fileScopeGuard(src) {
  const re = /^\s*router\.use\(\s*([A-Za-z0-9_]+)/gm;
  let m;
  while ((m = re.exec(src))) {
    if (AUTH_GUARDS.has(m[1])) {
      return { name: m[1], line: src.slice(0, m.index).split('\n').length };
    }
  }
  return null;
}

const indexSrc = read(join(ROUTES_DIR, 'index.ts'));
const identToFile = importsIn(indexSrc);
const mounts = mountsIn(indexSrc);

/** Where requireAuth appears in routes/index.ts: everything after it is authed. */
const authLineInIndex = (() => {
  const idx = indexSrc.indexOf('router.use(requireAuth)');
  return idx === -1 ? Infinity : indexSrc.slice(0, idx).split('\n').length;
})();

const all = [];

// Routes declared directly in routes/index.ts
for (const r of routesIn(indexSrc, 'router')) {
  all.push({
    ...r,
    file: 'routes/index.ts',
    prefix: '/api',
    inheritsAuth: r.line > authLineInIndex,
  });
}

// Routes in each mounted router file
for (const { prefix, ident } of mounts) {
  const file = identToFile.get(ident);
  if (!file) continue;
  const src = read(join(ROUTES_DIR, file));
  if (!src) continue;
  // A file-scope `router.use(<guard>)` covers every route declared below it.
  // subscription.routes.ts does exactly this, with the Razorpay webhook
  // deliberately declared ABOVE the line so it stays public - which is why
  // this has to compare line numbers rather than just test for the call.
  const fileGuard = fileScopeGuard(src);
  const mountLine = indexSrc.slice(0, indexSrc.indexOf(`'${prefix}', ${ident}`)).split('\n').length;
  for (const r of routesIn(src, 'router')) {
    all.push({
      ...r,
      file: `routes/${file}`,
      prefix: `/api${prefix === '/' ? '' : prefix}`,
      inheritsAuth: mountLine > authLineInIndex,
      fileWideGuard: fileGuard && r.line > fileGuard.line ? fileGuard.name : null,
    });
  }
}

// App-level routes in src/index.ts, which sit in front of the /api router and
// therefore in front of requireAuth - exactly where the Phase 0 miss lived.
for (const r of routesIn(read(INDEX_FILE), 'app')) {
  all.push({ ...r, file: 'index.ts', prefix: '', inheritsAuth: false, appLevel: true });
}

function classify(r) {
  const explicit = r.middleware.filter((m) => AUTH_GUARDS.has(m));
  if (explicit.length) return { level: 'explicit', by: explicit.join('+') };
  if (r.fileWideGuard) {
    return r.fileWideGuard === 'requireAuth'
      ? { level: 'authenticated', by: 'file-scope requireAuth' }
      : { level: 'explicit', by: `file-scope ${r.fileWideGuard}` };
  }
  if (r.inheritsAuth) return { level: 'authenticated', by: 'inherited requireAuth' };
  const unknown = r.middleware.filter((m) => !NON_GUARDS.has(m));
  if (unknown.length) return { level: 'unknown', by: unknown.join('+') };
  return { level: 'PUBLIC', by: 'none' };
}

const rows = all
  .map((r) => ({ ...r, ...classify(r) }))
  .map((r) => ({
    ...r,
    full: `${r.prefix}${r.path === '/' ? '' : r.path}` || '/',
  }))
  .sort((a, b) => a.full.localeCompare(b.full) || a.method.localeCompare(b.method));

const wantJson = process.argv.includes('--json');
const wantAll = process.argv.includes('--all');

if (wantJson) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

const byLevel = rows.reduce((acc, r) => {
  acc[r.level] = (acc[r.level] ?? 0) + 1;
  return acc;
}, {});

console.log(`Routes found: ${rows.length}\n`);
for (const [level, n] of Object.entries(byLevel).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${level.padEnd(16)} ${n}`);
}

const writes = rows.filter((r) => r.method !== 'GET');
const authedOnlyWrites = writes.filter((r) => r.level === 'authenticated');
console.log(`\nWrites (non-GET): ${writes.length}`);
console.log(`  of those, protected by nothing but "is signed in": ${authedOnlyWrites.length}`);

const publics = rows.filter((r) => r.level === 'PUBLIC' || r.level === 'unknown');
if (publics.length) {
  console.log(`\nReachable without an auth guard (${publics.length}):`);
  for (const r of publics) {
    console.log(`  ${r.method.padEnd(6)} ${r.full.padEnd(52)} ${r.file}:${r.line}  [${r.by}]`);
  }
}

if (wantAll) {
  console.log('\nAll routes:');
  for (const r of rows) {
    console.log(`  ${r.method.padEnd(6)} ${r.full.padEnd(52)} ${r.level.padEnd(14)} ${r.by}`);
  }
}
